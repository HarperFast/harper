/**
 * Shared helpers for `ModelBackend` implementations.
 *
 * Phase 6 of #510 extracted these from the ollama and openai backends after
 * landing the openai PR — Kris flagged the similarity, and with anthropic +
 * bedrock adding a third and fourth use the duplication crossed the
 * "extract" threshold.
 *
 * Each helper is provider-agnostic; backend-specific error classes are passed
 * in via a constructor type so the thrown errors carry the backend's name
 * for `instanceof` matching in tests.
 */
import { isUnresolvedEnvVarPlaceholder } from '../../utility/expandEnvVar.ts';
import type { TokenUsage } from './types.ts';

/** Constructor signature for backend-specific error classes. */
export type BackendErrorCtor = new (message: string) => Error;

/**
 * Combine a caller-supplied AbortSignal with a per-call timeout via
 * `AbortSignal.any`. Returns the caller signal directly when no timeout is
 * configured; the timeout signal alone when no caller signal exists; a
 * composed signal when both apply.
 */
export function composeSignal(caller?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
	if (!timeoutMs) return caller;
	const timeout = AbortSignal.timeout(timeoutMs);
	if (!caller) return timeout;
	return AbortSignal.any([caller, timeout]);
}

// ---------- retry (#1594) ----------

/** Retries after the initial attempt when the backend doesn't configure `maxRetries`. */
export const DEFAULT_MAX_RETRIES = 2;
/** Initial backoff when the backend doesn't configure `retryBackoffMs`; doubles per attempt. */
export const DEFAULT_RETRY_BACKOFF_MS = 500;
/** Upper bound on any single computed backoff sleep. */
export const MAX_RETRY_DELAY_MS = 10_000;
/**
 * Upper bound on an honored `Retry-After`. A server demanding a longer wait
 * is surfaced immediately rather than retried early (which would ignore the
 * server's request) or held open (which would stall the caller's write).
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** Config fields shared by every backend that supports retry. */
export interface RetryConfig {
	maxRetries?: number;
	retryBackoffMs?: number;
}

/**
 * Validate the retry knobs from a backend config entry, falling back to the
 * defaults on missing or malformed values (negative, non-integer `maxRetries`;
 * non-positive or non-finite `retryBackoffMs`). `maxRetries: 0` is a valid,
 * deliberate "no retries" setting.
 */
export function resolveRetryConfig(config: RetryConfig): { maxRetries: number; retryBackoffMs: number } {
	const { maxRetries, retryBackoffMs } = config;
	return {
		maxRetries:
			Number.isInteger(maxRetries) && (maxRetries as number) >= 0 ? (maxRetries as number) : DEFAULT_MAX_RETRIES,
		retryBackoffMs:
			typeof retryBackoffMs === 'number' && Number.isFinite(retryBackoffMs) && retryBackoffMs > 0
				? retryBackoffMs
				: DEFAULT_RETRY_BACKOFF_MS,
	};
}

/**
 * Statuses worth a same-backend retry: request timeout, rate limit, and server
 * errors (including Anthropic's 529 overloaded). Everything else — auth,
 * validation, not-found — is deterministic and re-attempting it just burns quota.
 */
export function isRetriableStatus(status: number): boolean {
	return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Parse a `Retry-After` response header (delta-seconds or HTTP-date form) into
 * milliseconds from now. Returns `undefined` for absent/unparseable values;
 * clamps a past HTTP-date to 0.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
	const date = Date.parse(header);
	if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
	return undefined;
}

/**
 * Jittered exponential backoff: `baseMs * 2^attempt`, capped at
 * `MAX_RETRY_DELAY_MS`, scaled by a random factor in [0.5, 1). The half floor
 * keeps the backoff meaningful under jitter; the cap bounds the tail. `random`
 * is injectable for deterministic tests.
 */
export function computeRetryDelayMs(attempt: number, baseMs: number, random: () => number = Math.random): number {
	const exponential = Math.min(MAX_RETRY_DELAY_MS, baseMs * 2 ** attempt);
	return exponential * (0.5 + random() * 0.5);
}

/** Abort-driven rejections (caller abort or `AbortSignal.timeout`) — deliberate deadlines, never retried. */
function isAbortError(err: unknown): boolean {
	const name = (err as { name?: string } | null)?.name;
	return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * `setTimeout` as a promise that rejects immediately with the signal's reason
 * when `signal` aborts, so a backoff sleep never outlives the caller's deadline.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal!.reason ?? new DOMException('This operation was aborted', 'AbortError'));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export interface FetchRetryOpts {
	/** Retries after the initial attempt. 0 = single attempt. */
	maxRetries: number;
	/** Initial backoff in ms; doubles per attempt with jitter. */
	retryBackoffMs: number;
	/** Test seam — replaces `abortableSleep`. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Test seam — replaces `Math.random` in the jitter computation. */
	random?: () => number;
}

/**
 * `fetch` with bounded same-endpoint retries (#1594): retriable HTTP statuses
 * (`isRetriableStatus`) and transient network rejections re-attempt with
 * jittered exponential backoff, honoring `Retry-After` when present (up to
 * `MAX_RETRY_AFTER_MS` — a longer server-requested wait surfaces the response
 * instead). Every attempt and backoff sleep runs under `init.signal`, so a
 * composed caller-abort/`requestTimeoutMs` signal remains the overall deadline
 * for the whole call — retries fit inside the existing budget rather than
 * extending it — and aborts are never retried. The final attempt's response is
 * returned unread (ok or not) so the caller's error path can consume the body;
 * earlier retriable responses have their bodies cancelled to release the
 * connection. Mid-stream failures after a returned `ok` response are the
 * caller's concern — a partially consumed stream is not retriable here.
 */
export async function fetchWithRetry(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	opts: FetchRetryOpts
): Promise<Response> {
	const sleep = opts.sleep ?? abortableSleep;
	const signal = init.signal ?? undefined;
	for (let attempt = 0; ; attempt++) {
		let res: Response;
		try {
			res = await fetchImpl(url, init);
		} catch (err) {
			if (attempt >= opts.maxRetries || signal?.aborted || isAbortError(err)) throw err;
			await sleep(computeRetryDelayMs(attempt, opts.retryBackoffMs, opts.random), signal);
			continue;
		}
		if (res.ok || !isRetriableStatus(res.status) || attempt >= opts.maxRetries) return res;
		const retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after') ?? null);
		if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) return res;
		try {
			res.body?.cancel?.()?.catch?.(() => {});
		} catch {
			// A locked or already-disturbed body can't be cancelled; the retry proceeds regardless.
		}
		await sleep(retryAfterMs ?? computeRetryDelayMs(attempt, opts.retryBackoffMs, opts.random), signal);
	}
}

/**
 * Write a token count to `usage` only when the value is a finite, non-negative
 * integer. Drops `NaN`, `Infinity`, negatives, and non-integers silently —
 * upstream-supplied bad counts would otherwise poison aggregates over
 * `hdb_model_calls` (`SUM(prompt_tokens)` returns `NaN` for the whole window
 * if any row carries `NaN`).
 */
export function assignFiniteTokenCount(
	usage: TokenUsage,
	key: 'promptTokens' | 'completionTokens' | 'embeddingTokens',
	value: unknown
): void {
	if (typeof value !== 'number') return;
	if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return;
	usage[key] = value;
}

// Body-read caps. A hostile or buggy upstream that returns a multi-GiB body
// would otherwise OOM the process before we reject the call.
// Success responses must accommodate the largest LEGAL embedding batch: OpenAI
// accepts up to 2048 inputs per request, and text-embedding-3-large returns
// 3072 floats each — roughly 125-190 MiB of JSON. 256 MiB clears that with
// headroom while still bounding a runaway upstream.
// Error responses are small prose strings; 256 KiB is generous.
export const MAX_RESPONSE_BODY_BYTES = 256 << 20; // 256 MiB
export const MAX_ERROR_BODY_BYTES = 256 << 10; // 256 KiB

// Module-level TextDecoder avoids per-call allocation in the streaming read path.
const BODY_DECODER = new TextDecoder('utf-8');

/**
 * Read at most `maxBytes` from `res.body`, then JSON.parse. Throws the
 * caller's error class — never a bare `SyntaxError` or `RangeError` — so
 * the caller's `instanceof` checks stay consistent.
 *
 * A response whose body exceeds `maxBytes` is an explicit failure rather than
 * a silent partial read; the caller's error class surfaces the diagnosis.
 */
export async function readBoundedJson<T>(
	res: Response,
	endpoint: string,
	Err: BackendErrorCtor,
	maxBytes: number
): Promise<T> {
	if (!res.body) {
		// No body at all — treat the same as invalid JSON.
		throw new Err(`${endpoint} returned an empty response body`);
	}
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			totalBytes += chunk.byteLength;
			if (totalBytes > maxBytes) {
				// Release the connection promptly before throwing.
				res.body?.cancel?.().catch(() => {});
				throw new Err(
					`${endpoint} response body exceeds ${maxBytes}-byte limit (received >${totalBytes} bytes); ` +
						'rejecting to prevent unbounded memory use'
				);
			}
			chunks.push(chunk);
		}
	} catch (err) {
		// Re-wrap unexpected stream errors (network abort, socket reset, etc.)
		// so callers always see the backend's Err class, not a raw DOMException
		// or Node stream error. Don't rewrap errors we already constructed above.
		if (err instanceof Err) throw err;
		throw new Err(`${endpoint} stream error while reading response body: ${(err as Error)?.message ?? err}`);
	}
	const merged =
		totalBytes === 0
			? ''
			: BODY_DECODER.decode(
					chunks.length === 1
						? chunks[0]
						: (() => {
								const buf = new Uint8Array(totalBytes);
								let offset = 0;
								for (const c of chunks) {
									buf.set(c, offset);
									offset += c.byteLength;
								}
								return buf;
							})()
				);
	try {
		return JSON.parse(merged) as T;
	} catch {
		throw new Err(`${endpoint} returned a non-JSON response body`);
	}
}

/**
 * Read a JSON response body and throw the backend's error class on parse
 * failure rather than leaking the raw `SyntaxError` (whose message can
 * include upstream-derived bytes). Matches the sanitization posture from
 * `analyticsTable.ts:35` ("Sanitized code (...). Never a raw upstream
 * message.").
 *
 * Caps the read at `MAX_RESPONSE_BODY_BYTES` (256 MiB) to bound memory use
 * on hostile or misbehaving upstream endpoints.
 */
export async function parseJsonResponse<T>(res: Response, endpoint: string, Err: BackendErrorCtor): Promise<T> {
	return readBoundedJson<T>(res, endpoint, Err, MAX_RESPONSE_BODY_BYTES);
}

/**
 * Assert that a model name was specified — either via `opts.model` (per-call
 * override) or the backend's configured default.
 */
export function requireModel(model: string | undefined, op: string, Err: BackendErrorCtor): asserts model is string {
	if (!model) {
		throw new Err(`No model specified for ${op}; set 'model' in config or pass opts.model`);
	}
}

/**
 * Validate a configured credential field (typically `apiKey`):
 * - must be present and non-empty
 * - must NOT be a literal `${VAR_NAME}` placeholder that survived because the
 *   env var was unset at boot (the `bootstrap.ts` expansion runs through
 *   `expandEnvVarsDeep`, but unresolved placeholders pass through unchanged)
 *
 * Returns the validated value or throws. The `backendLabel` prefixes the
 * error message so operators see which backend's config failed.
 */
export function requireCredential(
	value: string | undefined,
	backendLabel: string,
	fieldName: string,
	Err: BackendErrorCtor
): string {
	if (!value || value.length === 0) {
		throw new Err(`${backendLabel} backend requires ${fieldName}`);
	}
	if (isUnresolvedEnvVarPlaceholder(value)) {
		throw new Err(
			`${backendLabel} ${fieldName} is the literal placeholder ${value}; set the matching env var before starting Harper`
		);
	}
	return value;
}

/**
 * Normalize a config-supplied host/origin into a fully-qualified base URL.
 *
 * - Falls back to `defaults.host` when value is empty
 * - Prepends `http://` or `https://` (per `defaults.secure`) when no scheme present
 * - Strips trailing slashes so callers can `${origin}${path}` cleanly
 *
 * Backend-specific behavior collapses to choosing the right `defaults`:
 * Ollama → `{ host: 'localhost:11434', secure: false }`; OpenAI →
 * `{ host: 'api.openai.com/v1', secure: true }`; etc.
 */
export function normalizeOrigin(value: string | undefined, defaults: { host: string; secure: boolean }): string {
	const v = value?.trim() || defaults.host;
	const withScheme = /^https?:\/\//i.test(v) ? v : (defaults.secure ? 'https://' : 'http://') + v;
	return withScheme.replace(/\/+$/, '');
}
