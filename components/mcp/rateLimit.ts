/**
 * Per-session, per-tool, and per-client rate limiting for `tools/call`.
 *
 * Configurable limits per profile (operations / application):
 *   - perToolPerSecond:   sustained per-tool rate (token bucket refill)
 *   - perToolBurst:       per-tool burst capacity (token bucket size)
 *   - sessionConcurrency: max in-flight tool calls per session
 *   - sessionPerSecond:   sustained per-session rate across all tools
 *   - perClientPerSecond / perClientBurst (#1610, default OFF): sustained
 *     rate keyed on CLIENT IDENTITY rather than session. Session buckets are
 *     trivially cycled by an anonymous client (initialize → call → drop
 *     session → repeat); the client bucket survives that loop.
 *   - identityHeader (#1610): identity is the socket IP by default; proxied
 *     deployments can name a trusted header (e.g. `x-forwarded-for`) whose
 *     first (client-most) value is used instead. Only set this when the
 *     proxy strips the header from untrusted traffic — a client-controlled
 *     header is a limit bypass.
 *
 * Limit hits surface as `result.isError = true` with `kind: 'rate_limited'`
 * (NOT a JSON-RPC error) per the MCP spec's tools-call convention. The LLM
 * sees and adapts; the protocol envelope stays clean.
 *
 * State is in-memory per worker process. Buckets are evicted lazily when
 * a session's record is removed (#619 cleanup) or after they've been idle
 * past the idle eviction threshold. Multi-process coordination isn't
 * attempted in v1 — the limits are per-worker. For durable cross-restart
 * quotas (per-IP daily counters and the like), see the config-named quota
 * hook in `quota.ts` (#1610).
 */
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';

export interface RateLimitConfig {
	perToolPerSecond: number;
	perToolBurst: number;
	sessionConcurrency: number;
	sessionPerSecond: number;
	/** 0 disables the per-client-identity bucket (the default). */
	perClientPerSecond: number;
	perClientBurst: number;
	/** Trusted header (lowercased) to derive client identity from; absent = socket IP. */
	identityHeader?: string;
}

const DEFAULTS: Record<'operations' | 'application', RateLimitConfig> = {
	operations: {
		perToolPerSecond: 10,
		perToolBurst: 20,
		sessionConcurrency: 25,
		sessionPerSecond: 100,
		perClientPerSecond: 0,
		perClientBurst: 0,
	},
	application: {
		perToolPerSecond: 25,
		perToolBurst: 50,
		sessionConcurrency: 50,
		sessionPerSecond: 200,
		perClientPerSecond: 0,
		perClientBurst: 0,
	},
};

const CONFIG_KEYS = {
	operations: {
		perToolPerSecond: CONFIG_PARAMS.MCP_OPERATIONS_RATELIMIT_PERTOOLPERSECOND,
		perToolBurst: CONFIG_PARAMS.MCP_OPERATIONS_RATELIMIT_PERTOOLBURST,
		sessionConcurrency: CONFIG_PARAMS.MCP_OPERATIONS_RATELIMIT_SESSIONCONCURRENCY,
		sessionPerSecond: CONFIG_PARAMS.MCP_OPERATIONS_RATELIMIT_SESSIONPERSECOND,
		perClientPerSecond: CONFIG_PARAMS.MCP_OPERATIONS_RATELIMIT_PERCLIENTPERSECOND,
		perClientBurst: CONFIG_PARAMS.MCP_OPERATIONS_RATELIMIT_PERCLIENTBURST,
		identityHeader: CONFIG_PARAMS.MCP_OPERATIONS_RATELIMIT_IDENTITYHEADER,
	},
	application: {
		perToolPerSecond: CONFIG_PARAMS.MCP_APPLICATION_RATELIMIT_PERTOOLPERSECOND,
		perToolBurst: CONFIG_PARAMS.MCP_APPLICATION_RATELIMIT_PERTOOLBURST,
		sessionConcurrency: CONFIG_PARAMS.MCP_APPLICATION_RATELIMIT_SESSIONCONCURRENCY,
		sessionPerSecond: CONFIG_PARAMS.MCP_APPLICATION_RATELIMIT_SESSIONPERSECOND,
		perClientPerSecond: CONFIG_PARAMS.MCP_APPLICATION_RATELIMIT_PERCLIENTPERSECOND,
		perClientBurst: CONFIG_PARAMS.MCP_APPLICATION_RATELIMIT_PERCLIENTBURST,
		identityHeader: CONFIG_PARAMS.MCP_APPLICATION_RATELIMIT_IDENTITYHEADER,
	},
};

// tools/call is a hot path and `resolveClientIdentity` runs per call; reading
// 6–7 env keys and allocating a config object each time is avoidable GC/CPU
// pressure. Cache per profile with a short TTL — config edits still take
// effect within seconds, matching the per-session capture semantics closely
// enough while keeping the steady-state cost to a Map hit.
const CONFIG_TTL_MS = 10_000;
const configCache = new Map<string, { config: RateLimitConfig; at: number }>();
let warnedIdentityHeader = false;

export function configFor(profile: 'operations' | 'application'): RateLimitConfig {
	const cached = configCache.get(profile);
	const t = now();
	if (cached && t - cached.at < CONFIG_TTL_MS) return cached.config;
	const config = buildConfig(profile);
	if (config.identityHeader && !warnedIdentityHeader) {
		warnedIdentityHeader = true;
		harperLogger.warn(
			`MCP ${profile} rateLimit.identityHeader='${config.identityHeader}' derives client identity from a request header; ensure the fronting proxy STRIPS or REPLACES this header on untrusted traffic, or clients can spoof identities and bypass per-client limits`
		);
	}
	configCache.set(profile, { config, at: t });
	return config;
}

function buildConfig(profile: 'operations' | 'application'): RateLimitConfig {
	const keys = CONFIG_KEYS[profile];
	const defaults = DEFAULTS[profile];
	const read = (key: string, fallback: number): number => {
		const v = env.get(key);
		return typeof v === 'number' && v > 0 ? v : fallback;
	};
	const identityHeader = env.get(keys.identityHeader);
	const perClientPerSecond = read(keys.perClientPerSecond, defaults.perClientPerSecond);
	return {
		perToolPerSecond: read(keys.perToolPerSecond, defaults.perToolPerSecond),
		perToolBurst: read(keys.perToolBurst, defaults.perToolBurst),
		sessionConcurrency: read(keys.sessionConcurrency, defaults.sessionConcurrency),
		sessionPerSecond: read(keys.sessionPerSecond, defaults.sessionPerSecond),
		perClientPerSecond,
		// Burst defaults to the sustained rate when unset, so enabling the
		// limit is a one-key change — floored at 1 token, else a fractional
		// rate (0.1/s = "6 per minute") yields a bucket that can never admit
		// (consume requires a whole token and refill caps at burst).
		perClientBurst: read(keys.perClientBurst, perClientPerSecond > 0 ? Math.max(1, perClientPerSecond) : 0),
		...(typeof identityHeader === 'string' && identityHeader ? { identityHeader: identityHeader.toLowerCase() } : {}),
	};
}

/**
 * Derive the client identity for per-client limiting and the durable quota
 * hook (#1610): the configured trusted header's first (client-most) value
 * when set, else the transport-provided socket IP. Returns undefined when
 * neither is available — callers skip client-scoped checks then.
 */
export function resolveClientIdentity(
	headers: Record<string, string | undefined>,
	clientIp: string | undefined,
	profile: 'operations' | 'application'
): string | undefined {
	const config = configFor(profile);
	if (config.identityHeader) {
		const raw = headers[config.identityHeader];
		if (raw) {
			const first = raw.split(',')[0].trim();
			if (first) return first;
		}
	}
	return clientIp || undefined;
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

// Per-client-identity buckets, keyed `${profile}\n${identity}`. Deliberately
// SEPARATE from session state: the whole point is surviving session cycling,
// so their lifetime must not be tied to any session's (#1610).
interface ClientState {
	rate: TokenBucket;
	lastSeen: number;
}
const clients = new Map<string, ClientState>();

// Belt-and-braces against state leaks: sessions that get TTL-evicted from the
// system.mcp_session table never reach deleteSession() in this process, so
// `clearSessionRateState` is never called for them. Prune any session that
// hasn't admitted a call in this many ms on every getOrCreate. The threshold
// is generously above the default idle timeout (1800s) — well-behaved live
// sessions never get pruned by accident. Client buckets ride the same sweep.
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
	for (const [key, c] of clients) {
		if (c.lastSeen < cutoff) {
			clients.delete(key);
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

function getOrCreateClient(
	identity: string,
	profile: 'operations' | 'application',
	config: RateLimitConfig
): ClientState {
	const key = `${profile}\n${identity}`;
	let c = clients.get(key);
	if (!c) {
		c = { rate: new TokenBucket(config.perClientPerSecond, config.perClientBurst), lastSeen: now() };
		clients.set(key, c);
	} else {
		c.lastSeen = now();
	}
	return c;
}

/** Drop a session's rate-limit state (called on session deletion). */
export function clearSessionRateState(sessionId: string): void {
	sessions.delete(sessionId);
}

/** Test seam: drop all sessions, client buckets, and the config cache. */
export function _resetForTest(): void {
	sessions.clear();
	clients.clear();
	configCache.clear();
	warnedIdentityHeader = false;
}

export type RateLimitDecision =
	| { allowed: true; release: () => void }
	| { allowed: false; reason: 'per_tool' | 'session_rate' | 'concurrency' | 'per_client' };

/**
 * Attempt to admit a tools/call. If allowed, returns a `release()` that
 * decrements in-flight; the caller MUST invoke it (even on tool failure)
 * via `try { ... } finally { release(); }`.
 *
 * `clientIdentity` (from `resolveClientIdentity`) engages the per-client
 * bucket when the profile configures `perClientPerSecond` — the scope that
 * survives session cycling (#1610). Absent identity or a 0 rate skips it.
 */
export function tryAdmit(
	sessionId: string,
	toolName: string,
	profile: 'operations' | 'application',
	clientIdentity?: string
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
	const clientState =
		state.config.perClientPerSecond > 0 && clientIdentity
			? getOrCreateClient(clientIdentity, profile, state.config)
			: undefined;
	// Peek every bucket first. Consuming one before checking another silently
	// drains the unrelated bucket on the denied path.
	if (!toolBucket.hasToken()) {
		return { allowed: false, reason: 'per_tool' };
	}
	if (!state.sessionRate.hasToken()) {
		return { allowed: false, reason: 'session_rate' };
	}
	if (clientState && !clientState.rate.hasToken()) {
		return { allowed: false, reason: 'per_client' };
	}
	// All have capacity — actually deduct. The peeks above ran refill(), so
	// these immediate-follow-up tryConsume calls see the same fresh state and
	// are guaranteed to succeed (refill() is a no-op for elapsedSec ≤ 0).
	toolBucket.tryConsume();
	state.sessionRate.tryConsume();
	clientState?.rate.tryConsume();
	state.inFlight += 1;
	return {
		allowed: true,
		release: () => {
			if (state.inFlight > 0) state.inFlight -= 1;
		},
	};
}
