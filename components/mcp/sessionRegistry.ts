/**
 * Per-worker in-memory registry of active MCP sessions with open GET-SSE
 * streams. The persistent session record lives in `system.mcp_session`
 * (RocksDB); this registry holds the things that can't be persisted —
 * the live IterableEventQueue, plus per-session snapshots of the last
 * `tools/list` / `resources/list` results so the listChanged dispatcher
 * can suppress no-op notifications.
 *
 * Per-worker only. A session's GET stream is bound to the worker that
 * accepted the GET; cross-worker fan-out isn't attempted in v1.
 */
import { IterableEventQueue } from '../../resources/IterableEventQueue.ts';
import type { AuthedUser } from './toolRegistry.ts';
import type { McpProfile } from './transport.ts';

export interface SseEvent {
	event?: string;
	data?: unknown;
	id?: string;
}

export interface RegisteredSession {
	sessionId: string;
	profile: McpProfile;
	user: AuthedUser;
	queue: IterableEventQueue<SseEvent>;
	/** Most recent tools/list payload sent on this session — used for diffing. */
	lastTools?: ReadonlyArray<{ name: string }>;
	/** Most recent resources/list payload sent on this session — used for diffing. */
	lastResources?: ReadonlyArray<{ uri: string }>;
}

const registry: Map<string, RegisteredSession> = new Map();

export function registerSession(sessionId: string, profile: McpProfile, user: AuthedUser): RegisteredSession {
	const existing = registry.get(sessionId);
	if (existing) {
		// A client that opens a second GET on the same session id supersedes
		// the first. Close the prior stream so callers don't dangle.
		existing.queue.emit('close');
	}
	const queue = new IterableEventQueue<SseEvent>();
	const record: RegisteredSession = { sessionId, profile, user, queue };
	registry.set(sessionId, record);
	return record;
}

export function unregisterSession(sessionId: string): void {
	const record = registry.get(sessionId);
	if (!record) return;
	record.queue.emit('close');
	registry.delete(sessionId);
}

export function getRegisteredSession(sessionId: string): RegisteredSession | undefined {
	return registry.get(sessionId);
}

/**
 * Apply a callback to every session matching `profile`. Used by the
 * listChanged dispatcher to recompute lists per-session.
 */
export function forEachSessionByProfile(profile: McpProfile, cb: (record: RegisteredSession) => void): void {
	for (const record of registry.values()) {
		if (record.profile === profile) cb(record);
	}
}

/** Test seam — drop all sessions. */
export function _resetSessionRegistryForTest(): void {
	for (const r of registry.values()) {
		r.queue.emit('close');
	}
	registry.clear();
}

/** Test seam — peek count. */
export function _sessionRegistrySize(): number {
	return registry.size;
}
