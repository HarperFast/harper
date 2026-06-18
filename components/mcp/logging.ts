/**
 * MCP logging utility (`logging/setLevel` + `notifications/message`).
 *
 * The MCP spec models logging on RFC 5424 syslog severities. A client raises
 * or lowers the minimum severity it wants via `logging/setLevel`; the server
 * then emits `notifications/message` frames at or above that severity over the
 * session's SSE channel.
 *
 * Scope (see the MCP design doc issue): we deliberately emit only Harper
 * *MCP-layer* events here — not the global `harperLogger` stream. Harper's
 * logger has no subscription hook (only a `writeToLog` injected at
 * `createLogger` time), and its records are process-wide and cross-worker:
 * forwarding them to an authenticated MCP client would be both a confidentiality
 * leak and an unbounded firehose. So this module is a small, explicit emitter
 * the MCP code calls for noteworthy, session-scoped, non-sensitive events.
 */
import { forEachSessionByProfile, getRegisteredSession, type RegisteredSession } from './sessionRegistry.ts';
import type { McpProfile } from './transport.ts';

// RFC 5424 severities, ordered least → most severe (index === rank).
const MCP_LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'] as const;

export type McpLogLevel = (typeof MCP_LOG_LEVELS)[number];

const LEVEL_RANK = new Map<string, number>(MCP_LOG_LEVELS.map((level, i) => [level, i]));

export function isValidMcpLogLevel(value: unknown): value is McpLogLevel {
	return typeof value === 'string' && LEVEL_RANK.has(value);
}

/**
 * Apply the minimum level to the session's *live* in-memory `RegisteredSession`
 * (the SSE delivery point), if its GET stream is open on this worker. No-op
 * otherwise. The durable source of truth is `McpSessionRecord.logLevel`
 * (persisted by the `logging/setLevel` handler and used to seed this live value
 * when the stream (re)connects), so a pre-stream `setLevel` is not lost.
 */
export function setSessionLogLevel(sessionId: string, level: McpLogLevel): void {
	const record = getRegisteredSession(sessionId);
	if (record) record.logLevel = level;
}

export function getSessionLogLevel(sessionId: string): McpLogLevel | undefined {
	return getRegisteredSession(sessionId)?.logLevel;
}

/**
 * A session admits a record only once it has set a level (no unsolicited
 * messages before `logging/setLevel`), and only when the record's severity is
 * at or above the session's configured minimum.
 */
function admits(record: RegisteredSession, recordLevel: McpLogLevel): boolean {
	const min = record.logLevel;
	if (min === undefined) return false;
	const recordRank = LEVEL_RANK.get(recordLevel);
	const minRank = LEVEL_RANK.get(min);
	// An unrecognized level (shouldn't reach here given the typed callers, but be
	// defensive) is not admitted rather than defaulting to rank 0 and slipping
	// past a `debug` minimum.
	if (recordRank === undefined || minRank === undefined) return false;
	return recordRank >= minRank;
}

interface LogMessageParams {
	level: McpLogLevel;
	logger?: string;
	data: unknown;
}

function logFrame(params: LogMessageParams): { event: string; data: object } {
	return { event: 'message', data: { jsonrpc: '2.0', method: 'notifications/message', params } };
}

/**
 * Emit a `notifications/message` to a single session, if it has an open SSE
 * stream and its level admits this severity. No-op otherwise.
 */
export function emitMcpLogToSession(sessionId: string, level: McpLogLevel, data: unknown, logger?: string): void {
	const record = getRegisteredSession(sessionId);
	if (!record || !admits(record, level)) return;
	record.queue.send(logFrame({ level, logger, data }));
}

/**
 * Emit a `notifications/message` to every session on a profile whose level
 * admits this severity.
 */
export function emitMcpLogToProfile(profile: McpProfile, level: McpLogLevel, data: unknown, logger?: string): void {
	forEachSessionByProfile(profile, (record) => {
		if (admits(record, level)) {
			record.queue.send(logFrame({ level, logger, data }));
		}
	});
}
