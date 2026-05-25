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

/**
 * Read a JSON response body and throw the backend's error class on parse
 * failure rather than leaking the raw `SyntaxError` (whose message can
 * include upstream-derived bytes). Matches the sanitization posture from
 * `analyticsTable.ts:35` ("Sanitized code (...). Never a raw upstream
 * message.").
 */
export async function parseJsonResponse<T>(res: Response, endpoint: string, Err: BackendErrorCtor): Promise<T> {
	try {
		return (await res.json()) as T;
	} catch {
		throw new Err(`${endpoint} returned a non-JSON response body`);
	}
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
