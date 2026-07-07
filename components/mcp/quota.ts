/**
 * Durable, operator-pluggable quota hook for MCP `tools/call` (#1610).
 *
 * The in-memory buckets in `rateLimit.ts` bound instantaneous rates but are
 * per-worker and reset on restart — insufficient as a COST control for a
 * public unauthenticated tool (an LLM-backed `answer`, say). This hook lets
 * the operator implement a durable policy (e.g. a persisted per-IP daily
 * counter table) behind config:
 *
 *   mcp:
 *     application:
 *       quota:
 *         resource: McpQuota        # exported Resource path
 *         method: allowMcpCall      # static method on it (this is the default)
 *
 * Before each admitted tools/call, Harper calls
 * `QuotaClass.allowMcpCall({ identity, tool, user, profile, sessionId })`.
 * Return `true` (or any truthy non-object) to allow; return
 * `{ allowed: false, message?, retryAfterSeconds? }` to deny — the denial
 * surfaces to the client as `isError` with `kind: 'quota_exceeded'`.
 * Counting is the hook's business: increment on check, or on success via
 * your own bookkeeping — Harper calls once per attempted tool call.
 *
 * FAIL-CLOSED: a hook that throws (or a configured resource/method that
 * doesn't resolve) DENIES the call. Cost protection that silently disables
 * itself on a bug is worse than a hard failure (#1422 set this precedent
 * for allow* hooks). The raw error goes to the server log only.
 *
 * Dispatch uses the LIVE registry class, same as custom tools — an exported
 * subclass replacing the entry on reload wins.
 */
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import type { McpProfile } from './transport.ts';
import type { AuthedUser } from './toolRegistry.ts';

export interface QuotaCheckInfo {
	/** Client identity from `resolveClientIdentity` (socket IP or trusted-header value); may be undefined. */
	identity?: string;
	tool: string;
	user: AuthedUser;
	profile: McpProfile;
	sessionId: string;
}

export interface QuotaDenial {
	allowed: false;
	/** Shown to the client verbatim — author-controlled, keep it safe. */
	message?: string;
	retryAfterSeconds?: number;
}

export type QuotaDecision = { allowed: true } | QuotaDenial;

const CONFIG_KEYS: Record<McpProfile, { resource: string; method: string }> = {
	operations: {
		resource: CONFIG_PARAMS.MCP_OPERATIONS_QUOTA_RESOURCE,
		method: CONFIG_PARAMS.MCP_OPERATIONS_QUOTA_METHOD,
	},
	application: {
		resource: CONFIG_PARAMS.MCP_APPLICATION_QUOTA_RESOURCE,
		method: CONFIG_PARAMS.MCP_APPLICATION_QUOTA_METHOD,
	},
};

const DEFAULT_METHOD = 'allowMcpCall';

type ResourcesLike = Map<string, { Resource: unknown }> | undefined;

// Test seam — mirrors resources.ts: the real registry initializes the whole
// Harper graph at import, which unit tests can't do.
let _resourcesOverride: ResourcesLike;
export function _setQuotaResourcesForTest(r: ResourcesLike): void {
	_resourcesOverride = r;
}

function getResources(): ResourcesLike {
	if (_resourcesOverride) return _resourcesOverride;
	const { resources } = require('../../resources/Resources');
	return resources as ResourcesLike;
}

/** Warn-once state for a misconfigured hook (missing resource/method). */
let warnedMisconfigured = false;
export function _resetQuotaWarningsForTest(): void {
	warnedMisconfigured = false;
}

/**
 * Run the configured durable quota hook, if any. Returns `{allowed: true}`
 * when no hook is configured (the feature is opt-in). Misconfiguration and
 * hook errors DENY (fail-closed) with a sanitized message.
 */
export async function checkDurableQuota(info: QuotaCheckInfo): Promise<QuotaDecision> {
	const keys = CONFIG_KEYS[info.profile];
	const resourcePath = env.get(keys.resource);
	if (typeof resourcePath !== 'string' || !resourcePath) {
		return { allowed: true };
	}
	const methodName =
		typeof env.get(keys.method) === 'string' && env.get(keys.method) ? env.get(keys.method) : DEFAULT_METHOD;
	const entry = getResources()?.get(resourcePath);
	const QuotaClass = entry?.Resource as Record<string, unknown> | undefined;
	const method = QuotaClass?.[methodName as string];
	if (typeof method !== 'function') {
		if (!warnedMisconfigured) {
			warnedMisconfigured = true;
			harperLogger.warn(
				`MCP ${info.profile} quota hook misconfigured: no exported resource '${resourcePath}' with static method '${methodName}'; DENYING tool calls (fail-closed)`
			);
		}
		return { allowed: false, message: 'quota policy unavailable' };
	}
	try {
		const result = await (method as (i: QuotaCheckInfo) => unknown).call(QuotaClass, info);
		if (result && typeof result === 'object') {
			const decision = result as { allowed?: unknown; message?: unknown; retryAfterSeconds?: unknown };
			if (decision.allowed === false) {
				return {
					allowed: false,
					...(typeof decision.message === 'string' ? { message: decision.message } : {}),
					...(typeof decision.retryAfterSeconds === 'number' ? { retryAfterSeconds: decision.retryAfterSeconds } : {}),
				};
			}
			return { allowed: true };
		}
		return result ? { allowed: true } : { allowed: false };
	} catch (error) {
		harperLogger.error(
			`MCP ${info.profile} quota hook '${resourcePath}.${methodName}' threw; denying (fail-closed)`,
			error
		);
		return { allowed: false, message: 'quota check failed' };
	}
}
