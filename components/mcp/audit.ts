/**
 * Per-`tools/call` audit logging. Emits a structured info-level log entry
 * for every tool invocation so operators can replay who-did-what after the
 * fact. The shape mirrors what Harper's existing operations audit captures
 * (operation, user, status, duration) plus MCP-specific identity
 * (session id, profile, tool name).
 *
 * Argument summarization runs through a redaction step that drops anything
 * that looks like a credential (key/secret/password). Operators who need
 * stricter PII handling configure `mcp.audit.argumentRedactor` to a custom
 * function via a future component-author hook (v1.1).
 */
import harperLogger from '../../utility/logging/harper_logger.ts';

export interface AuditEntry {
	timestamp: string;
	profile: 'operations' | 'application';
	sessionId: string;
	tool: string;
	user: string;
	args: object;
	status: 'ok' | 'isError' | 'rate_limited' | 'protocol_error';
	durationMs: number;
	errorMessage?: string;
}

const REDACTION_PATTERN = /(secret|password|token|api[-_]?key|credentials?|auth)/i;
// Exact field names that carry secret material without a credential-looking name: `value`/`values`
// (set_secret plaintext, set_env_value .env secrets) and `envelope` (set_secret ciphertext). These
// mirror the fields processLocalTransaction strips from the REST operations log — the MCP audit
// path must not become a bypass. Exact-match so e.g. `search_value` stays auditable.
const REDACTION_EXACT_FIELDS = /^(value|values|envelope)$/i;
// ...but only for the operations that actually put secrets in those generically-named fields.
// `value`/`values` are common, non-secret params on many other operations (record data, config
// values), so blanket-redacting them would gut the audit trail for unrelated tools. The global
// REDACTION_PATTERN still applies to every tool; this just narrows the exact-field masking to the
// secret-bearing ops. NOTE: extend this set if a new op ever carries a secret in a plain field.
const EXACT_FIELD_TOOLS = new Set(['set_secret', 'set_env_value']);
const REDACTION_PLACEHOLDER = '[redacted]';
const MAX_REDACTION_DEPTH = 10;

/**
 * Recursively walk an object and replace values for keys matching the
 * redaction pattern. Bounded depth so a pathological cyclic input doesn't
 * stall the audit emit; on overflow the entire sub-object is redacted so
 * a credential buried below the depth limit cannot leak. Returns a shallow
 * clone — the caller's payload is never mutated.
 */
export function redactArgs(value: unknown, depth = 0, redactExactFields = false): unknown {
	if (value === null || typeof value !== 'object') return value;
	if (depth > MAX_REDACTION_DEPTH) return REDACTION_PLACEHOLDER;
	if (Array.isArray(value)) {
		return value.map((v) => redactArgs(v, depth + 1, redactExactFields));
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		if (REDACTION_PATTERN.test(k) || (redactExactFields && REDACTION_EXACT_FIELDS.test(k))) {
			out[k] = REDACTION_PLACEHOLDER;
		} else {
			out[k] = redactArgs(v, depth + 1, redactExactFields);
		}
	}
	return out;
}

/** Mask a session id for logging — first 8 chars, suffix elided. */
export function maskSessionId(id: string): string {
	if (typeof id !== 'string' || id.length <= 8) return id;
	return `${id.slice(0, 8)}…`;
}

/**
 * Emit a single audit entry. Writes to the structured log channel as INFO
 * so it's captured by Harper's standard log rotation; downstream tooling
 * can filter on `category: 'mcp.audit'`.
 */
export function emitAuditEntry(entry: AuditEntry): void {
	try {
		const masked = {
			...entry,
			sessionId: maskSessionId(entry.sessionId),
			args: redactArgs(entry.args, 0, EXACT_FIELD_TOOLS.has(entry.tool)),
		};
		harperLogger.info({ category: 'mcp.audit', ...masked });
	} catch (err) {
		// Audit emission must never break a tool call. If logging itself fails
		// (logger disposed, disk full, whatever), trace-log the loss and move on.
		harperLogger.trace(`MCP audit emit failed: ${(err as Error).message}`);
	}
}
