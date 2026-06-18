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
 *
 * Lifecycle: an entry is created on GET-SSE open and removed via three
 * paths — explicit DELETE (transport calls `deleteSession`), the on-close
 * hook fired when the consumer's async-iterator returns/throws (e.g.
 * client drop), or the idle-prune sweep that catches zombies the close
 * hook missed (e.g. a proxy holding the connection after the client died
 * without a graceful close).
 */
import { IterableEventQueue } from '../../resources/IterableEventQueue.ts';
import type { McpLogLevel } from './logging.ts';
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
	/** Minimum `notifications/message` severity set via `logging/setLevel`; undefined = none. */
	logLevel?: McpLogLevel;
	/** Wall-clock ms of last activity. Bumped by registerSession + touchSession. */
	lastSeen: number;
}

const registry: Map<string, RegisteredSession> = new Map();

const IDLE_PRUNE_MS = 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
let lastPruneAt = 0;

let now: () => number = () => Date.now();
export function _setClockForTest(fn: (() => number) | undefined): void {
	now = fn ?? (() => Date.now());
}

function pruneIdleSessions(): void {
	const t = now();
	if (t - lastPruneAt < PRUNE_INTERVAL_MS) return;
	lastPruneAt = t;
	const cutoff = t - IDLE_PRUNE_MS;
	for (const [id, record] of registry) {
		// Don't prune sessions whose iterator is actively awaiting data; that
		// signals a live consumer mid-stream. Belt-and-braces around lastSeen.
		if (record.queue.resolveNext !== null) continue;
		if (record.lastSeen < cutoff) {
			record.queue.emit('close');
			registry.delete(id);
		}
	}
}

export function registerSession(sessionId: string, profile: McpProfile, user: AuthedUser): RegisteredSession {
	pruneIdleSessions();
	const existing = registry.get(sessionId);
	if (existing) {
		// A client that opens a second GET on the same session id supersedes
		// the first. Close the prior stream so callers don't dangle.
		existing.queue.emit('close');
	}
	const queue = new IterableEventQueue<SseEvent>();
	const record: RegisteredSession = { sessionId, profile, user, queue, lastSeen: now() };
	registry.set(sessionId, record);
	// On-close hook: when the consumer's async-iterator returns/throws (or
	// supersede emits 'close' above), drop the entry so it doesn't leak past
	// the underlying HTTP stream's lifetime. We delete directly rather than
	// calling unregisterSession() — the latter would re-emit 'close', firing
	// any other user-registered 'close' listeners a second time.
	queue.once('close', () => {
		// Only delete if we're still the live record. A racing supersede
		// could have already replaced us in the map.
		if (registry.get(sessionId) === record) {
			registry.delete(sessionId);
		}
	});
	return record;
}

export function unregisterSession(sessionId: string): void {
	const record = registry.get(sessionId);
	if (!record) return;
	registry.delete(sessionId);
	record.queue.emit('close');
}

export function getRegisteredSession(sessionId: string): RegisteredSession | undefined {
	return registry.get(sessionId);
}

/**
 * Mark a session as having activity right now (e.g. a `tools/call` came in).
 * Keeps idle-prune from sweeping live sessions whose GET stream is dormant
 * between server-push events. Distinct from `session.touchSession` — that
 * one updates the persistent RocksDB record's `lastActivity`; this one
 * updates the in-memory registry's `lastSeen` (used only by the idle-prune).
 */
export function touchRegisteredSession(sessionId: string): void {
	const record = registry.get(sessionId);
	if (record) record.lastSeen = now();
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
	lastPruneAt = 0;
}

/** Test seam — peek count. */
export function _sessionRegistrySize(): number {
	return registry.size;
}
