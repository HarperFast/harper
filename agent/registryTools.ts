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
import harperLogger from '../utility/logging/harper_logger.ts';
import type { AgentTool, AgentToolContext } from './types.ts';

const log = harperLogger.loggerWithTag('agent');

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
	return {
		def: { name: def.name, description: def.description, parameters: def.inputSchema },
		// The loop's approval gate keys off `destructive`; the registry expresses the same
		// intent as the MCP `destructiveHint` annotation.
		destructive: def.annotations?.destructiveHint === true,
		handler: async (args: object, ctx: AgentToolContext) => {
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
			if (result.isError) throw new Error(errorText(result));
			return result.structuredContent ?? textOf(result);
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
