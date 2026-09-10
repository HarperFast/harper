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
	/** Advance, but never lower, the version floor from the transaction that owns the actual write timestamp. */
	noteHolderVersion(version: number): void;
	/** Preserve a caller timestamp as a candidate floor without treating it as a committed write. */
	noteCandidateFloor(version: number): void;
	/** Compute a holder-write version without advancing the floor until that write commits. */
	holderVersionCandidate(floor?: number): number;
	/**
	 * Return the next version to stamp a holder write with. Starts at acquiredAt when no transaction
	 * version has been noted; otherwise advances by the minimum monotonic step from the recorded floor.
	 */
	nextHolderVersion(): number;
	release(): boolean;
	/**
	 * Flip this handle to hold mode and reset its lease timer. Used during scoped→hold upgrades
	 * so all instances that reference this handle object remain valid (no retire + replace).
	 */
	upgradeToHold(lease: number): void;
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

/**
 * The 409 for a write staged through a handle that is no longer live. A lease that ran out and a
 * lock that was handed back are different causes, and a caller told the wrong one debugs the wrong
 * thing — a commit-released scoped handle is not a timeout.
 */
export function lockNotHeldError(handle: Pick<RecordLockHandle, 'expired'>): ClientError {
	return new ClientError(handle.expired ? 'Record lock lease expired' : 'Record lock already released', 409);
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
	#candidateFloor: number | undefined;
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

	noteHolderVersion(version: number): void {
		this.#lastHolderVersion = Math.max(this.#lastHolderVersion ?? version, version);
	}

	noteCandidateFloor(version: number): void {
		this.#candidateFloor = Math.max(this.#candidateFloor ?? version, version);
	}

	holderVersionCandidate(floor?: number): number {
		// A small nonzero step prevents exact LWW ties without materially moving past the observed floor.
		const MIN_STEP = 0.000488;
		return Math.max(
			this.#lastHolderVersion != null ? this.#lastHolderVersion + MIN_STEP : this.acquiredAt,
			this.acquiredAt,
			this.#candidateFloor ?? -Infinity,
			floor ?? -Infinity
		);
	}

	nextHolderVersion(): number {
		const next = this.holderVersionCandidate();
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

	upgradeToHold(lease: number): void {
		this.hold = true;
		clearTimeout(this.#timer);
		this.expiresAt = Date.now() + lease;
		this.#timer = setTimeout(() => this.#onLeaseExpire(), lease).unref();
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
