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
	keyId: unknown; // writeKeyId(id), used to scan the per-transaction recordLocks array
	expiresAt: number;
	hold: boolean;
	released: boolean;
	expired: boolean;
	/** Monotonic timestamp at which tryLock succeeded; used as the base version for holder writes. */
	acquiredAt: number;
	/**
	 * Return the next version to stamp a holder write with. Starts at acquiredAt; increments by
	 * the minimum monotonic step for every subsequent call so sequential saves on the same hold do
	 * not collide on version while still staying ≤ any concurrent write that happened after
	 * lock acquisition.
	 */
	nextHolderVersion(): number;
	release(): boolean;
	/**
	 * Mark this handle as released and clear its lease timer WITHOUT calling store.unlock().
	 * Use during scoped→hold upgrades where the native key ownership transfers to the new hold
	 * handle; store.unlock() must NOT fire so the key stays locked under the new holder.
	 */
	retire(): void;
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

class KeyLockHandle implements RecordLockHandle {
	store: any;
	key: any[];
	keyId: unknown;
	expiresAt: number;
	hold: boolean;
	released = false;
	expired = false;
	acquiredAt: number;
	#lastHolderVersion: number | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(store: any, key: any[], keyId: unknown, lease?: number, hold = false, acquiredAt?: number) {
		this.store = store;
		this.key = key;
		this.keyId = keyId;
		this.expiresAt = lease != null ? Date.now() + lease : Infinity;
		this.hold = hold;
		this.acquiredAt = acquiredAt ?? store.getMonotonicTimestamp();
		if (lease != null) {
			this.#timer = setTimeout(() => this.#onLeaseExpire(), lease).unref();
		}
	}

	nextHolderVersion(): number {
		// Minimum monotonic step matches getNextMonotonicTime()'s own increment.
		const MIN_STEP = 0.000488;
		const next =
			this.#lastHolderVersion != null ? Math.max(this.#lastHolderVersion + MIN_STEP, this.acquiredAt) : this.acquiredAt;
		this.#lastHolderVersion = next;
		return next;
	}

	#onLeaseExpire() {
		if (this.released) return;
		this.released = true;
		this.expired = true;
		try {
			this.store.unlock(this.key);
		} catch (err) {
			if (!warnedLeaseTimerStores.has(this.store)) {
				warnedLeaseTimerStores.add(this.store);
				harperLogger.warn?.('record lock lease timer failed (store may have been dropped)', err);
			}
		}
	}

	release(): boolean {
		if (this.released) return false;
		this.released = true;
		clearTimeout(this.#timer);
		try {
			this.store.unlock(this.key);
		} catch (err) {
			if (!warnedLeaseTimerStores.has(this.store)) {
				warnedLeaseTimerStores.add(this.store);
				harperLogger.warn?.('record lock release failed (store may have been dropped)', err);
			}
		}
		return true;
	}

	retire(): void {
		if (this.released) return;
		this.released = true;
		clearTimeout(this.#timer);
		// Intentionally does NOT call store.unlock(): the native key stays locked under the
		// new hold handle that takes ownership during a scoped→hold upgrade.
	}
}

export function makeKeyLockHandle(
	store: any,
	key: any[],
	keyId: unknown,
	lease?: number,
	hold = false,
	acquiredAt?: number
): RecordLockHandle {
	return new KeyLockHandle(store, key, keyId, lease, hold, acquiredAt);
}

/**
 * Acquire the native key lock for a record, looping until acquired or deadline passes. Re-entrant
 * within a transaction: if the transaction already holds this key (non-expired handle in its
 * recordLocks map) the existing handle is returned without a second tryLock.
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
	// One persistent wake slot: at most one onUnlocked callback is registered per waiter at any
	// time.  After the callback fires (holder released), hasCallback is cleared so the next
	// tryLock can register a fresh callback for the new holder.  When the timeout fires instead
	// (the holder has not released yet), hasCallback stays true and subsequent retries skip the
	// callback registration, preventing unbounded accumulation on a hot key.
	let wakeResolve: (() => void) | undefined;
	let hasCallback = false;
	while (true) {
		const onUnlocked = hasCallback
			? undefined
			: () => {
					hasCallback = false;
					wakeResolve?.();
				};
		const acquired = store.tryLock(key, onUnlocked);
		if (acquired) return makeKeyLockHandle(store, key, keyId, lease, hold, store.getMonotonicTimestamp());
		if (onUnlocked) hasCallback = true; // callback now registered; do not register another until it fires
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new ClientError(`Record is locked and was not released in time`, 423);
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, remaining).unref();
			wakeResolve = () => {
				clearTimeout(t);
				resolve();
			};
		});
		wakeResolve = undefined;
	}
}
