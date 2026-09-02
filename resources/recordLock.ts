import harperLogger from '../utility/logging/harper_logger.ts';
import { ClientError } from '../utility/errors/hdbError.ts';

/**
 * Exclusive per-record locks (harper#483, Phase 0: one node, every worker thread).
 *
 * The sole authority is the rocksdb-js process-wide key lock: one `locks` map per DBDescriptor
 * shared by every worker thread's handle. Nothing is written to the store or audit log. Lock and
 * unlock are pure in-memory operations; the record's version and bytes are unchanged.
 */

export const DEFAULT_LOCK_LEASE_MS = 30_000;
/** Below this a generation can expire before the caller's work completes, handing back a lock already lost. */
export const MIN_LOCK_LEASE_MS = 100;
export const MAX_LOCK_LEASE_MS = 300_000;
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
export const MAX_LOCK_TIMEOUT_MS = 300_000;
/** How long a write to a record another party holds waits for the release before failing (423). */
export const LOCKED_WRITE_WAIT_MS = 30_000;

let lockedWriteWaitMs = LOCKED_WRITE_WAIT_MS;

/** Override for tests; must not lower the production default in production code. */
export function setLockedWriteWaitMs(ms: number): void {
	lockedWriteWaitMs = ms;
}

export function getLockedWriteWaitMs(): number {
	return lockedWriteWaitMs;
}

const LOCK_KEY_PREFIX = Symbol.for('record-lock');

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

/**
 * The handle returned by `lock()` and held by each gated write until its transaction completes.
 * `release()` is synchronous: it calls `store.unlock(key)` which is ownerless and fires any
 * waiting callbacks cross-thread. The `expired` flag is set in the holder thread by the lease
 * timer, so a stale holder cannot accidentally call unlock after its lease already fired and
 * released the key to a new holder.
 */
export interface RecordLockHandle {
	store: any;
	key: any[]; // lockAttemptKey, passed to store.tryLock / store.unlock
	keyId: unknown; // writeKeyId(id), Map key in the per-transaction recordLocks sub-map
	expiresAt: number;
	hold: boolean;
	released: boolean;
	expired: boolean;
	release(): boolean;
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

/** The advisory key for this (table, record) pair, distinct from getFromSource's bare-id single-flight lock. */
export function lockAttemptKey(tableId: number, id: any): any[] {
	return Array.isArray(id) ? [LOCK_KEY_PREFIX, tableId, ...id] : [LOCK_KEY_PREFIX, tableId, id];
}

const warnedLeaseTimerStores = new WeakSet();

/**
 * Create a key-lock handle. Gate handles (lease = undefined) have no expiry timer and are released
 * when the transaction commits or aborts via releaseRecordLocks. Lock() handles have a lease timer
 * that fires store.unlock() if the holder never calls release().
 */
export function makeKeyLockHandle(
	store: any,
	key: any[],
	keyId: unknown,
	lease?: number,
	hold = false
): RecordLockHandle {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const handle: RecordLockHandle = {
		store,
		key,
		keyId,
		expiresAt: lease != null ? Date.now() + lease : Infinity,
		hold,
		released: false,
		expired: false,
		release(): boolean {
			if (handle.released) return false;
			handle.released = true;
			clearTimeout(timer);
			try {
				store.unlock(key);
			} catch (err) {
				if (!warnedLeaseTimerStores.has(store)) {
					warnedLeaseTimerStores.add(store);
					harperLogger.warn?.('record lock release failed (store may have been dropped)', err);
				}
			}
			return true;
		},
	};
	if (lease != null) {
		timer = setTimeout(() => {
			if (!handle.released) {
				handle.released = true;
				handle.expired = true;
				try {
					store.unlock(key);
				} catch (err) {
					if (!warnedLeaseTimerStores.has(store)) {
						warnedLeaseTimerStores.add(store);
						harperLogger.warn?.('record lock lease timer failed (store may have been dropped)', err);
					}
				}
			}
		}, lease).unref();
	}
	return handle;
}

/**
 * Acquire the native key lock for a record, looping until acquired or deadline passes. Re-entrant
 * within a transaction: if the transaction already holds this key (non-expired handle in its
 * recordLocks map) the existing handle is returned without a second tryLock.
 *
 * Used by both `lock()` (with a user lease) and the write-gate's async commit path (no lease).
 */
export async function acquireRecordKey(
	txn: { recordLockFor(store: any, keyId: unknown): RecordLockHandle | undefined },
	store: any,
	key: any[],
	keyId: unknown,
	waitMs: number,
	lease?: number,
	hold = false
): Promise<RecordLockHandle> {
	const existing = txn.recordLockFor(store, keyId);
	if (existing && !existing.released && !existing.expired) return existing;

	const deadline = Date.now() + waitMs;
	while (true) {
		let wakeResolve: (() => void) | undefined;
		const acquired = store.tryLock(key, () => {
			wakeResolve?.();
		});
		if (acquired) return makeKeyLockHandle(store, key, keyId, lease, hold);
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new ClientError(`Record is locked and was not released in time`, 423);
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, remaining);
			wakeResolve = () => {
				clearTimeout(t);
				resolve();
			};
		});
	}
}
