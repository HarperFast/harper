/**
 * Durable, operator-pluggable quota hook for MCP `tools/call` (#1610).
 *
 * The in-memory buckets in `rateLimit.ts` bound instantaneous rates but are
 * per-worker and reset on restart — insufficient as a COST control for a
 * public unauthenticated tool (an LLM-backed `answer`, say). A component
 * registers a durable policy (e.g. a persisted per-IP daily counter) as a
 * function, so the policy is never itself an exposed Resource:
 *
 *   // in a component's resources.js, at module top level
 *   server.setMcpQuotaHandler(async ({ identity, tool, user, profile, sessionId }) => {
 *     if (profile !== 'application') return true;   // gate per-profile in code
 *     const used = await bumpCounter(identity);
 *     return used > DAILY_LIMIT ? { allowed: false, message: 'daily quota reached' } : true;
 *   });
 *
 * Before each admitted tools/call Harper calls the registered handler. Return
 * `true` (or any truthy non-object) to allow; return
 * `{ allowed: false, message?, retryAfterSeconds? }` to deny — the denial
 * surfaces to the client as `isError` with `kind: 'quota_exceeded'`.
 * Counting is the handler's business: increment on check, or on success via
 * your own bookkeeping — Harper calls once per attempted tool call.
 *
 * FAIL-CLOSED: a handler that throws DENIES the call. Cost protection that
 * silently disables itself on a bug is worse than a hard failure (#1422 set
 * this precedent for allow* hooks). The raw error goes to the server log only.
 *
 * RACE-SAFETY: the handler can run concurrently for the SAME identity — within
 * a worker (interleaving across its own await boundaries) and across workers
 * (separate processes sharing the database). A naive read-then-write counter
 * (`get` → `put used+1`) can undercount under that concurrency and admit calls
 * past the limit. Production handlers should make the read-modify-write atomic:
 * run it in a transaction that serializes conflicting writers, use a
 * compare-and-set retry loop, or maintain the counter in a store with native
 * atomic increments.
 *
 * The latest registration wins, so a reloaded component replaces the previous
 * handler.
 */
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

/**
 * The durable quota policy: return `true` (or any truthy non-object) to allow,
 * or `{ allowed: false, message?, retryAfterSeconds? }` to deny. Receives the
 * per-call {@link QuotaCheckInfo}, including `profile`, so a single handler can
 * gate the operations and application profiles differently.
 */
export type McpQuotaHandler = (info: QuotaCheckInfo) => QuotaDecision | boolean | Promise<QuotaDecision | boolean>;

// Single, process-wide handler. Registered by a component via
// `server.setMcpQuotaHandler(fn)`; the latest registration wins (so a reloaded
// component replaces the previous one), and `undefined` clears it.
let quotaHandler: McpQuotaHandler | undefined;

export function setMcpQuotaHandler(handler: McpQuotaHandler | undefined): void {
	quotaHandler = handler;
}

/**
 * The currently-registered handler. Used by deploy pre-flight validation to snapshot
 * and restore around a throwaway candidate load, so a candidate's `setMcpQuotaHandler`
 * (or a failed deploy) can't leave its policy — or `undefined` — active on the live worker.
 */
export function getMcpQuotaHandler(): McpQuotaHandler | undefined {
	return quotaHandler;
}

/**
 * Run the registered durable quota handler, if any. Returns `{allowed: true}`
 * when no handler is registered (the feature is opt-in). A handler that throws
 * DENIES (fail-closed) with a sanitized message.
 */
export async function checkDurableQuota(info: QuotaCheckInfo): Promise<QuotaDecision> {
	if (!quotaHandler) {
		return { allowed: true };
	}
	try {
		const result = await quotaHandler(info);
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
		harperLogger.error(`MCP ${info.profile} quota handler threw; denying (fail-closed)`, error);
		return { allowed: false, message: 'quota check failed' };
	}
}
