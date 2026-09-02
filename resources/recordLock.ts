import { ClientError } from '../utility/errors/hdbError.ts';
import * as harperLogger from '../utility/logging/harper_logger.ts';
import type { Entry } from './RecordEncoder.ts';
import type { Id } from './ResourceInterface.ts';

/**
 * Exclusive per-record locks (harper#483, Phase 0: one node, every worker thread).
 *
 * The only authority is the durable, version-conditional LOCK write on the record itself: whoever's
 * conditional write commits holds the lock, and its version is the lock generation. Everything here
 * is advisory machinery around that write — bounded waits, a cross-worker wake-up, and the option
 * contract — so nothing in this module is ever consulted to decide ownership.
 */

/**
 * Record-metadata flag: the record carries a lock generation, encoded as `lockVersion` and
 * `lockExpiresAt` after the other optional metadata fields. Bit 2 is free in both the record-metadata
 * and audit extendedType namespaces and within the legacy two-byte compact form. Older Harper cannot
 * decode a record with this bit set, so a node that has locked records must not be downgraded below
 * this release.
 */
export const LOCKED = 4;

/** A lock generation is live until its lease passes; an expired one is treated as released. */
export function isLockedLive(entry: Partial<Entry> | undefined | null, now?: number): boolean {
	if (!entry || !(entry.metadataFlags & LOCKED)) return false; // the unlocked path never reads the clock
	return entry.lockExpiresAt > (now ?? Date.now());
}

/** Log without letting a throwing sink turn cleanup after a durable commit into a failure. */
function warnQuietly(message: string, error: unknown): void {
	try {
		harperLogger.warn?.(message, error);
	} catch {}
}

export const DEFAULT_LOCK_LEASE_MS = 30_000;
/** Below this a generation can expire before its own commit resolves, handing back a lock already lost. */
export const MIN_LOCK_LEASE_MS = 100;
export const MAX_LOCK_LEASE_MS = 300_000;
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
export const MAX_LOCK_TIMEOUT_MS = 300_000;
/** How long a write to a record another party holds waits for the release before failing (423). */
export const LOCKED_WRITE_WAIT_MS = 30_000;
/** Bound on serializing lock attempts through the engine's advisory lock; past it an attempt proceeds anyway. */
export const LOCK_ATTEMPT_SERIALIZER_WAIT_MS = 1_000;
/**
 * Versions are millisecond-epoch doubles, whose spacing is ~0.0005 ms; this step is the smallest
 * that always yields a strictly greater version there.
 */
export const LOCK_VERSION_STEP = 0.001;
const MAX_WAITERS_PER_KEY = 1_000;
const MAX_WAITERS_PER_WORKER = 10_000;
const DOORBELL_SLOTS = 4096;
const DOORBELL_KEY = 'record-lock-doorbell';
const LOCK_ATTEMPT_PREFIX = Symbol.for('record-lock');

export interface RecordLockOptions {
	/** Lease in ms; the lock expires on its own if the holder never releases it (default 30 s, max 5 min) */
	lease?: number;
	/** How long to wait for a contended lock in ms before failing with 423 (default 30 s, max 5 min) */
	timeout?: number;
	/** A held lock outlives the acquiring transaction; it is released by `unlock()` or by its lease */
	hold?: boolean;
}

export interface ResolvedRecordLockOptions {
	lease: number;
	timeout: number;
	hold: boolean;
}

export interface RecordLockHandle {
	store: any;
	key: Id;
	keyId: unknown;
	/** The lock generation: the LOCK audit entry's version, and the record version it committed */
	lockVersion: number;
	expiresAt: number;
	hold: boolean;
	released: boolean;
	/** Conditional UNLOCK of this generation; resolves true when this call cleared it */
	release(): Promise<boolean>;
}

function requireDuration(name: string, value: unknown, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min)
		throw new ClientError(
			`Lock option ${name} must be a number of milliseconds of at least ${min}, but received ${value}`
		);
	if (value > max) throw new ClientError(`Lock option ${name} must not exceed ${max}ms, but received ${value}`);
	return value;
}

export function resolveLockOptions(options?: RecordLockOptions | null): ResolvedRecordLockOptions {
	if (options != null && typeof options !== 'object')
		throw new ClientError(`Lock options must be an object, but received ${typeof options}`);
	const hold = options?.hold ?? false;
	if (typeof hold !== 'boolean') throw new ClientError(`Lock option hold must be a boolean, but received ${hold}`);
	return {
		lease: requireDuration('lease', options?.lease, DEFAULT_LOCK_LEASE_MS, MIN_LOCK_LEASE_MS, MAX_LOCK_LEASE_MS),
		timeout: requireDuration('timeout', options?.timeout, DEFAULT_LOCK_TIMEOUT_MS, 1, MAX_LOCK_TIMEOUT_MS),
		hold,
	};
}

/** A version strictly after both the transaction time and the record's current version. */
export function nextLockVersion(txnTime: number, existingVersion: number | undefined): number {
	const floor = existingVersion ?? 0;
	let version = Math.max(txnTime, floor + LOCK_VERSION_STEP);
	while (version <= floor) version += LOCK_VERSION_STEP;
	return version;
}

/**
 * Whether a write may stage against `entry` now: undefined when it may, 'wait' when another party's
 * live generation gates it, 'lost' when the writer's own generation was superseded.
 */
export function lockGateVerdict(
	entry: Partial<Entry> | undefined,
	holders: Array<RecordLockHandle | undefined>,
	now = Date.now()
): 'wait' | 'lost' | undefined {
	if (!isLockedLive(entry, now)) return;
	let sawHandle = false;
	for (const handle of holders) {
		if (!handle) continue;
		if (handle.lockVersion === entry.lockVersion) return;
		sawHandle = true;
	}
	return sawHandle ? 'lost' : 'wait';
}

/** The advisory attempt-serializer key: distinct from the bare-id single-flight lock getFromSource holds. */
export function lockAttemptKey(tableId: number, id: Id): any[] {
	return Array.isArray(id) ? [LOCK_ATTEMPT_PREFIX, tableId, ...id] : [LOCK_ATTEMPT_PREFIX, tableId, id];
}

/**
 * Run one lock attempt while holding the engine's cross-thread advisory lock, so a burst of
 * contenders on one node costs one conditional write per release instead of one per contender.
 * A wait past `waitMs` proceeds without it: the lock is never load-bearing.
 */
export async function serializeLockAttempt<T>(
	store: any,
	key: any,
	waitMs: number,
	attempt: () => Promise<T>
): Promise<T> {
	const deadline = Date.now() + waitMs;
	let acquired = false;
	while (true) {
		let wake: (() => void) | undefined;
		if ((acquired = store.tryLock(key, () => wake?.()))) break;
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, remaining);
			wake = () => {
				clearTimeout(timer);
				resolve();
			};
		});
	}
	try {
		return await attempt();
	} finally {
		if (acquired) store.unlock(key);
	}
}

type Waiter = {
	keyId: unknown;
	settle: (woken: boolean) => void;
};
// Waiters are grouped by doorbell slot, so a notification costs one counter read per slot that has
// waiters, not one per waiter; `seen` is the slot's counter when the group last (re)checked it.
type SlotGroup = { seen: number; waiters: Set<Waiter> };
type Doorbell = {
	slots: Int32Array;
	buffer: { notify(): void };
	bySlot: Map<number, SlotGroup>;
	perKey: Map<unknown, number>;
	count: number;
};
const doorbells = new WeakMap<object, Doorbell>();

function doorbellFor(store: any): Doorbell {
	let doorbell = doorbells.get(store);
	if (doorbell) return doorbell;
	doorbell = { slots: undefined as any, buffer: undefined as any, bySlot: new Map(), perKey: new Map(), count: 0 };
	const bell = doorbell;
	// One table-wide shared buffer of per-slot release counters: a release bumps its key's slot and
	// notifies every thread; only the slots whose counter moved wake their waiters.
	bell.buffer = store.getUserSharedBuffer(DOORBELL_KEY, new ArrayBuffer(DOORBELL_SLOTS * 4), {
		callback: () => wakeWaiters(bell),
	});
	bell.slots = new Int32Array(bell.buffer as unknown as ArrayBuffer, 0, DOORBELL_SLOTS);
	doorbells.set(store, bell);
	return bell;
}

function slotOf(keyId: unknown): number {
	const text = typeof keyId === 'string' ? keyId : String(keyId);
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % DOORBELL_SLOTS;
}

function wakeWaiters(doorbell: Doorbell) {
	for (const [slot, group] of doorbell.bySlot) {
		const seq = Atomics.load(doorbell.slots, slot);
		if (seq === group.seen) continue;
		group.seen = seq;
		for (const waiter of group.waiters) waiter.settle(true);
	}
}

/**
 * Wait until the record's lock is released (resolves true) or `until` passes (false). The wake-up is
 * advisory: a caller re-reads the record on every wake and decides from that. `stillLocked` is
 * consulted once the waiter is registered, so a release that lands between the caller's read and the
 * registration cannot be slept through.
 */
export function waitForRecordUnlock(
	store: any,
	keyId: unknown,
	until: number,
	stillLocked?: () => boolean
): { promise: Promise<boolean>; cancel: () => void } {
	const doorbell = doorbellFor(store);
	const waitingOnKey = doorbell.perKey.get(keyId) ?? 0;
	if (waitingOnKey >= MAX_WAITERS_PER_KEY || doorbell.count >= MAX_WAITERS_PER_WORKER)
		throw new ClientError('Too many requests are waiting for record locks, please try again later', 429);
	doorbell.perKey.set(keyId, waitingOnKey + 1);
	doorbell.count++;
	const slot = slotOf(keyId);
	let group = doorbell.bySlot.get(slot);
	if (!group) doorbell.bySlot.set(slot, (group = { seen: Atomics.load(doorbell.slots, slot), waiters: new Set() }));
	let settle: (woken: boolean) => void;
	const promise = new Promise<boolean>((resolve) => {
		const waiter: Waiter = { keyId, settle: undefined as any };
		const timer = setTimeout(() => waiter.settle(false), Math.max(0, until - Date.now()));
		settle = waiter.settle = (woken: boolean) => {
			if (!group.waiters.delete(waiter)) return;
			if (group.waiters.size === 0) doorbell.bySlot.delete(slot);
			doorbell.count--;
			clearTimeout(timer);
			const remaining = (doorbell.perKey.get(keyId) ?? 1) - 1;
			if (remaining > 0) doorbell.perKey.set(keyId, remaining);
			else doorbell.perKey.delete(keyId);
			resolve(woken);
		};
		group.waiters.add(waiter);
	});
	if (stillLocked && !stillLocked()) settle(true);
	return { promise, cancel: () => settle(false) };
}

/** Ring the doorbell for a key whose lock generation ended. Never throws: a missed wake-up costs a timer, not correctness. */
export function notifyRecordUnlocked(store: any, keyId: unknown): void {
	try {
		const doorbell = doorbellFor(store);
		Atomics.add(doorbell.slots, slotOf(keyId), 1);
		doorbell.buffer.notify();
		wakeWaiters(doorbell);
	} catch (error) {
		warnQuietly('Failed to notify record lock waiters', error);
	}
}
