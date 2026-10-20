/**
 * Registry tool composition for the built-in agent (#626).
 *
 * Folds the unified MCP tool registry (#615) — specifically the Operations
 * profile (#617) — into the agent's toolset. The agent consumes the *same*
 * registry the MCP HTTP server exposes, RBAC-filtered for its configured user,
 * so operators get one tool surface with one permission model.
 *
 * Two-step, mirroring the registry's own security model:
 *   1. `visibleTo(agentUser)` narrows *listing* — the LLM only sees tools it is
 *      likely allowed to call. This is NOT a security boundary.
 *   2. Real enforcement runs in the operation handler at call time: each call
 *      dispatches through Harper's operations runtime with `hdb_user` set to the
 *      agent's configured identity, so `verifyPerms` gates it regardless of what
 *      the LLM was shown.
 *
 * The Application profile (#618) is intentionally out of scope here; it can fold
 * in the same way once per-Resource tool generation is wired for the agent.
 */

import { registerOperationsTools } from '../components/mcp/tools/operations.ts';
import {
	listProfileTools,
	type AuthedUser,
	type ToolCallContext,
	type ToolDef as RegistryToolDef,
	type ToolResult,
} from '../components/mcp/toolRegistry.ts';
import { maskCredentialValues } from '../utility/credentials.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import { PRIVATE_KEY_ARMOR } from './tools/fsTools.ts';
import type { AgentTool, AgentToolContext } from './types.ts';

const log = harperLogger.loggerWithTag('agent');

/** Applied to one operation's calls and results before they reach the model and the transcript. */
interface ResultGuard {
	checkArgs(args: object): void;
	result(value: unknown): unknown;
	error(text: string): string;
}

const UNMASKABLE_LOG = 'read_log returned a result the agent cannot mask, so it is withheld';

/**
 * Log text holds whatever a component logged, so read_log is masked like the fs tools' read-only `logs`
 * scope. Its `filter` is refused: it matches the raw text before `start` and `limit` apply, so which entries
 * come back would answer whether a guessed value is in the log.
 */
const READ_LOG_GUARD: ResultGuard = {
	checkArgs(args) {
		if ((args as { filter?: unknown } | null)?.filter !== undefined) {
			throw new Error(
				"read_log's filter is not available to the agent, because it matches unmasked log text. Narrow the read with from, until, level, start and limit instead."
			);
		}
	},
	result(value) {
		const results = (value as { results?: unknown } | null)?.results;
		if (!Array.isArray(results)) throw new Error(UNMASKABLE_LOG);
		return { results: results.map(maskLogEntry) };
	},
	error(text) {
		return PRIVATE_KEY_ARMOR.test(text)
			? 'read_log failed, and its error text held a PEM private key, so it is withheld'
			: maskCredentialValues(text);
	},
};

const RESULT_GUARDS: ReadonlyMap<string, ResultGuard> = new Map([['read_log', READ_LOG_GUARD]]);

function maskLogEntry(entry: unknown): Record<string, unknown> {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(UNMASKABLE_LOG);
	const masked: Record<string, unknown> = {};
	let holdsKey = false;
	for (const [field, value] of Object.entries(entry)) {
		if (typeof value === 'string') {
			holdsKey ||= PRIVATE_KEY_ARMOR.test(value);
			masked[field] = maskCredentialValues(value);
		} else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
			holdsKey ||= value.some((item) => PRIVATE_KEY_ARMOR.test(item));
			masked[field] = value.map((item) => maskCredentialValues(item));
		} else if (value == null || typeof value === 'number' || typeof value === 'boolean') {
			masked[field] = value;
		} else {
			throw new Error(UNMASKABLE_LOG);
		}
	}
	return holdsKey
		? { timestamp: masked.timestamp, message: 'Refused: this log entry holds a PEM private key' }
		: masked;
}

let operationsRegistered = false;

/**
 * Populate the Operations profile on the main thread. Idempotent: guarded so a
 * second call (e.g. an `agent.enabled` flip via `set_agent_config`) is a no-op
 * rather than re-walking `OPERATION_FUNCTION_MAP` and re-logging. The registry's
 * `addTool` is `Map.set`-backed, so this stays correct whether or not the
 * operator also enabled the `mcp:` HTTP surface.
 */
export function ensureOperationsToolsRegistered(): void {
	if (operationsRegistered) return;
	registerOperationsTools();
	operationsRegistered = true;
}

/**
 * Adapt every Operations-profile registry tool into the agent's {@link AgentTool}
 * shape. Call {@link ensureOperationsToolsRegistered} first so the profile is
 * populated.
 *
 * Two identities, deliberately split:
 *   - `listingUser` filters `visibleTo` at compose time — which tools the LLM is
 *     *shown*. Listing is not a security boundary, so a startup snapshot is fine.
 *   - `resolveIdentity()` is called *per tool call* to set `hdb_user`, so the
 *     operation is enforced against the agent user's *current* role. This is what
 *     honors a role revocation/change without a restart — the enforcement identity
 *     is never cached in the handler closure.
 */
export function composeRegistryTools(listingUser: AuthedUser, resolveIdentity: () => Promise<AuthedUser>): AgentTool[] {
	const defs = listProfileTools('operations');
	const out: AgentTool[] = [];
	for (const def of defs) {
		if (!def.visibleTo(listingUser)) continue;
		out.push(adaptRegistryTool(def, resolveIdentity));
	}
	log.info?.(`Agent composed ${out.length} operations tool(s) for user '${listingUser?.username ?? 'unknown'}'`);
	return out;
}

function adaptRegistryTool(def: RegistryToolDef, resolveIdentity: () => Promise<AuthedUser>): AgentTool {
	const guard = RESULT_GUARDS.get(def.name);
	return {
		def: { name: def.name, description: def.description, parameters: def.inputSchema },
		// The loop's approval gate keys off `destructive`; the registry expresses the same
		// intent as the MCP `destructiveHint` annotation.
		destructive: def.annotations?.destructiveHint === true,
		handler: async (args: object, ctx: AgentToolContext) => {
			guard?.checkArgs(args);
			// Resolve the enforcement identity fresh so a live role change is honored. If the
			// configured user can no longer be resolved, `resolveIdentity` throws (fail closed) —
			// the loop turns that into a recoverable tool error rather than running with stale or
			// escalated privileges.
			const user = await resolveIdentity();
			const context: ToolCallContext = {
				user,
				profile: 'operations',
				sessionId: ctx.sessionId,
				...(ctx.signal ? { signal: ctx.signal } : {}),
			};
			const result = await def.handler(args, context);
			// The loop records a tool observation from the return value and turns a thrown error
			// into a structured `{ ok: false, error }` note for the next model turn. Mapping
			// `isError` → throw keeps a Harper operation failure a recoverable observation rather
			// than aborting the whole run.
			if (result.isError) throw new Error(guard ? guard.error(errorText(result)) : errorText(result));
			const value = result.structuredContent ?? textOf(result);
			return guard ? guard.result(value) : value;
		},
	};
}

function textOf(result: ToolResult): string {
	return (result.content ?? [])
		.filter((c) => c.type === 'text' && typeof c.text === 'string')
		.map((c) => c.text)
		.join('\n');
}

function errorText(result: ToolResult): string {
	const text = textOf(result);
	return text || 'operation failed';
}

/** Test-only: reset the one-time registration guard between specs. */
export function _resetRegistryToolsForTests(): void {
	operationsRegistered = false;
}
