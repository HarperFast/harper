/**
 * Per-`tools/call` audit logging. Emits a structured info-level log entry
 * for every tool invocation so operators can replay who-did-what after the
 * fact. The shape mirrors what Harper's existing operations audit captures
 * (operation, user, status, duration) plus MCP-specific identity
 * (session id, profile, tool name).
 *
 * Argument summarization runs through a redaction step that drops anything
 * that looks like a credential (secret/password/token). Operators who need
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
	status: 'ok' | 'isError' | 'rate_limited' | 'quota_exceeded' | 'protocol_error';
	durationMs: number;
	errorMessage?: string;
}

const REDACTION_PATTERN = /(secret|password|token|api[-_]?key|credentials?|auth)/i;
// Both secret-bearing tools carry all three fields, not just the ones each one declares: MCP
// forwards arguments as-is and audits them after the handler, so a mistyped `values` on set_secret
// (or `envelope` on set_env_value) is still logged despite being rejected — and the REST operations
// log strips all three unconditionally (UNLOGGABLE_OPERATION_FIELDS), so anything narrower here
// makes the audit path a bypass of it.
const SECRET_VALUE_FIELDS: ReadonlySet<string> = new Set(['value', 'values', 'envelope']);
// Scoped per tool because `value`/`values` are ordinary, non-secret params on many other
// operations (record data, config values); redacting them globally would gut the audit trail.
const REDACTION_FIELDS_BY_TOOL = new Map<string, ReadonlySet<string>>([
	['set_secret', SECRET_VALUE_FIELDS],
	['set_env_value', SECRET_VALUE_FIELDS],
	['add_ssh_key', new Set(['key'])],
	['update_ssh_key', new Set(['key'])],
]);
const REDACTION_PLACEHOLDER = '[redacted]';
const MAX_REDACTION_DEPTH = 10;

/**
 * Recursively walk an object and replace values for keys matching the
 * redaction pattern. Bounded depth so a pathological cyclic input doesn't
 * stall the audit emit; on overflow the entire sub-object is redacted so
 * a credential buried below the depth limit cannot leak. Returns a shallow
 * clone — the caller's payload is never mutated.
 */
export function redactArgs(value: unknown, depth = 0, redactionFields?: ReadonlySet<string>): unknown {
	if (value === null || typeof value !== 'object') return value;
	if (depth > MAX_REDACTION_DEPTH) return REDACTION_PLACEHOLDER;
	if (Array.isArray(value)) {
		return value.map((v) => redactArgs(v, depth + 1, redactionFields));
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		if (REDACTION_PATTERN.test(k) || redactionFields?.has(k.toLowerCase())) {
			out[k] = REDACTION_PLACEHOLDER;
		} else {
			out[k] = redactArgs(v, depth + 1, redactionFields);
		}
	}
	return out;
}

export function redactArgsForTool(value: unknown, tool: string): unknown {
	return redactArgs(value, 0, REDACTION_FIELDS_BY_TOOL.get(tool));
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
			args: redactArgsForTool(entry.args, entry.tool),
		};
		harperLogger.info({ category: 'mcp.audit', ...masked });
	} catch (err) {
		// Audit emission must never break a tool call. If logging itself fails
		// (logger disposed, disk full, whatever), trace-log the loss and move on.
		harperLogger.trace(`MCP audit emit failed: ${(err as Error).message}`);
	}
}
