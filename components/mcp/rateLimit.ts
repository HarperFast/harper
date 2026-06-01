/**
 * Per-session, per-tool rate limiting for `tools/call`.
 *
 * Four configurable limits per profile (operations / application):
 *   - perToolPerSecond:   sustained per-tool rate (token bucket refill)
 *   - perToolBurst:       per-tool burst capacity (token bucket size)
 *   - sessionConcurrency: max in-flight tool calls per session
 *   - sessionPerSecond:   sustained per-session rate across all tools
 *
 * Limit hits surface as `result.isError = true` with `kind: 'rate_limited'`
 * (NOT a JSON-RPC error) per the MCP spec's tools-call convention. The LLM
 * sees and adapts; the protocol envelope stays clean.
 *
 * State is in-memory per worker process. Buckets are evicted lazily when
 * a session's record is removed (#619 cleanup) or after they've been idle
 * past the idle eviction threshold. Multi-process coordination isn't
 * attempted in v1 — the limits are per-worker.
 */
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';

export interface RateLimitConfig {
	perToolPerSecond: number;
	perToolBurst: number;
	sessionConcurrency: number;
	sessionPerSecond: number;
}

const DEFAULTS: Record<'operations' | 'application', RateLimitConfig> = {
	operations: { perToolPerSecond: 10, perToolBurst: 20, sessionConcurrency: 25, sessionPerSecond: 100 },
	application: { perToolPerSecond: 25, perToolBurst: 50, sessionConcurrency: 50, sessionPerSecond: 200 },
};

const CONFIG_KEYS = {
	operations: {
		perToolPerSecond: CONFIG_PARAMS.MCP_OPERATIONS_RATELIMIT_PERTOOLPERSECOND,
		perToolBurst: CONFIG_PARAMS.MCP_OPERATIONS_RATELIMIT_PERTOOLBURST,
		sessionConcurrency: CONFIG_PARAMS.MCP_OPERATIONS_RATELIMIT_SESSIONCONCURRENCY,
		sessionPerSecond: CONFIG_PARAMS.MCP_OPERATIONS_RATELIMIT_SESSIONPERSECOND,
	},
	application: {
		perToolPerSecond: CONFIG_PARAMS.MCP_APPLICATION_RATELIMIT_PERTOOLPERSECOND,
		perToolBurst: CONFIG_PARAMS.MCP_APPLICATION_RATELIMIT_PERTOOLBURST,
		sessionConcurrency: CONFIG_PARAMS.MCP_APPLICATION_RATELIMIT_SESSIONCONCURRENCY,
		sessionPerSecond: CONFIG_PARAMS.MCP_APPLICATION_RATELIMIT_SESSIONPERSECOND,
	},
};

export function configFor(profile: 'operations' | 'application'): RateLimitConfig {
	const keys = CONFIG_KEYS[profile];
	const defaults = DEFAULTS[profile];
	const read = (key: string, fallback: number): number => {
		const v = env.get(key);
		return typeof v === 'number' && v > 0 ? v : fallback;
	};
	return {
		perToolPerSecond: read(keys.perToolPerSecond, defaults.perToolPerSecond),
		perToolBurst: read(keys.perToolBurst, defaults.perToolBurst),
		sessionConcurrency: read(keys.sessionConcurrency, defaults.sessionConcurrency),
		sessionPerSecond: read(keys.sessionPerSecond, defaults.sessionPerSecond),
	};
}

/**
 * Token bucket: starts full at `burst`, refills at `rate` tokens per
 * second up to `burst`, drained by `tryConsume(1)`. Stateless aside from
 * `tokens` + `lastRefill`, both updated on every consume call.
 */
class TokenBucket {
	private readonly rate: number;
	private readonly burst: number;
	private tokens: number;
	private lastRefill: number;
	constructor(rate: number, burst: number) {
		this.rate = rate;
		this.burst = burst;
		this.tokens = burst;
		this.lastRefill = now();
	}
	tryConsume(): boolean {
		this.refill();
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return true;
		}
		return false;
	}
	/**
	 * Refill-and-check, without consuming. Used by `tryAdmit` to peek each
	 * bucket so denial doesn't burn a token in *another* bucket.
	 */
	hasToken(): boolean {
		this.refill();
		return this.tokens >= 1;
	}
	private refill(): void {
		const t = now();
		const elapsedSec = (t - this.lastRefill) / 1000;
		this.lastRefill = t;
		if (elapsedSec <= 0) return;
		this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.rate);
	}
}

/** Lazily monkey-patchable for tests. */
let now: () => number = () => Date.now();
export function _setClockForTest(fn: (() => number) | undefined): void {
	now = fn ?? (() => Date.now());
}

interface SessionState {
	perTool: Map<string, TokenBucket>;
	sessionRate: TokenBucket;
	inFlight: number;
	config: RateLimitConfig;
	profile: 'operations' | 'application';
	lastSeen: number;
}

const sessions = new Map<string, SessionState>();

// Belt-and-braces against state leaks: sessions that get TTL-evicted from the
// system.mcp_session table never reach deleteSession() in this process, so
// `clearSessionRateState` is never called for them. Prune any session that
// hasn't admitted a call in this many ms on every getOrCreate. The threshold
// is generously above the default idle timeout (1800s) — well-behaved live
// sessions never get pruned by accident.
const IDLE_PRUNE_MS = 60 * 60 * 1000; // 1 hour
const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // run at most every 5 minutes
let lastPruneAt = 0;

function pruneIdleSessions(): void {
	const t = now();
	if (t - lastPruneAt < PRUNE_INTERVAL_MS) return;
	lastPruneAt = t;
	const cutoff = t - IDLE_PRUNE_MS;
	for (const [id, s] of sessions) {
		if (s.inFlight === 0 && s.lastSeen < cutoff) {
			sessions.delete(id);
		}
	}
}

function getOrCreate(sessionId: string, profile: 'operations' | 'application'): SessionState {
	pruneIdleSessions();
	let s = sessions.get(sessionId);
	if (!s) {
		const config = configFor(profile);
		s = {
			perTool: new Map(),
			sessionRate: new TokenBucket(config.sessionPerSecond, config.sessionPerSecond),
			inFlight: 0,
			config,
			profile,
			lastSeen: now(),
		};
		sessions.set(sessionId, s);
	} else {
		s.lastSeen = now();
	}
	return s;
}

/** Drop a session's rate-limit state (called on session deletion). */
export function clearSessionRateState(sessionId: string): void {
	sessions.delete(sessionId);
}

/** Test seam: drop all sessions. */
export function _resetForTest(): void {
	sessions.clear();
}

export type RateLimitDecision =
	| { allowed: true; release: () => void }
	| { allowed: false; reason: 'per_tool' | 'session_rate' | 'concurrency' };

/**
 * Attempt to admit a tools/call. If allowed, returns a `release()` that
 * decrements in-flight; the caller MUST invoke it (even on tool failure)
 * via `try { ... } finally { release(); }`.
 */
export function tryAdmit(
	sessionId: string,
	toolName: string,
	profile: 'operations' | 'application'
): RateLimitDecision {
	const state = getOrCreate(sessionId, profile);
	if (state.inFlight >= state.config.sessionConcurrency) {
		return { allowed: false, reason: 'concurrency' };
	}
	let toolBucket = state.perTool.get(toolName);
	if (!toolBucket) {
		toolBucket = new TokenBucket(state.config.perToolPerSecond, state.config.perToolBurst);
		state.perTool.set(toolName, toolBucket);
	}
	// Peek both buckets first. Consuming session-rate before checking per-tool
	// (or vice versa) silently drains the unrelated bucket on the denied path.
	if (!toolBucket.hasToken()) {
		return { allowed: false, reason: 'per_tool' };
	}
	if (!state.sessionRate.hasToken()) {
		return { allowed: false, reason: 'session_rate' };
	}
	// Both have capacity — actually deduct. The peeks above ran refill(), so
	// this immediate-follow-up tryConsume sees the same fresh state and is
	// guaranteed to succeed (refill() is a no-op for elapsedSec ≤ 0).
	toolBucket.tryConsume();
	state.sessionRate.tryConsume();
	state.inFlight += 1;
	return {
		allowed: true,
		release: () => {
			if (state.inFlight > 0) state.inFlight -= 1;
		},
	};
}
