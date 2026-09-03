import { performance } from 'node:perf_hooks';
import harperLogger from '../utility/logging/harper_logger.ts';
import { ClientError } from '../utility/errors/hdbError.ts';

/**
 * Exclusive per-record locks (harper#483).
 *
 * The intra-node authority is the rocksdb-js process-wide key lock: one `locks` map per DBDescriptor
 * shared by every worker thread's handle. Acquiring and releasing it write nothing to the store, and
 * the record's version and bytes are unchanged.
 *
 * Phase 1 layers cluster-wide exclusion on top without changing that: once the native key is held,
 * `Table.lock()` runs a Ricart-Agrawala round over replicated control entries (see
 * `recordLockCoordinator.ts`) and calls `joinClusterRound()` on the handle. A node-scoped lock
 * (`{ scope: 'node' }`), or any lock on a database with no transport registered, skips that round
 * entirely and behaves exactly as it did in Phase 0.
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
	/**
	 * `'cluster'` (default) is exclusive across every participating node; `'node'` keeps Phase 0
	 * semantics and is exclusive only across this node's worker threads.
	 */
	scope?: 'cluster' | 'node';
}

export interface ResolvedRecordLockOptions {
	lease: number;
	timeout: number;
	hold: boolean;
	scope: 'cluster' | 'node';
	/** True when the caller named `scope` explicitly, which makes `'cluster'` fail-closed. */
	scopeRequested: boolean;
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
	/** `ts_R` of the granted cluster round; undefined while the hold is node-scoped (Phase 0). */
	clusterTsR?: number;
	/**
	 * Whether this handle may still authorize a write, evaluated NOW rather than trusting the lease
	 * timer to have run. A holder whose event loop stalled past its deadline would otherwise commit
	 * between the deadline and its own timer callback, while peers had already expired the hold.
	 * Expiry is detected on a monotonic clock, so a wall-clock jump cannot extend a lease.
	 */
	isExpired(): boolean;
	/**
	 * Re-anchor a granted cluster round: the hold now runs from `tsR` (no margin, so this node
	 * always expires before any participant does) and `onRelease` emits the durable LOCK_RELEASE.
	 * Returns false when the round completed after the lease had already elapsed.
	 */
	joinClusterRound(tsR: number, leaseMs: number, onRelease: () => void): boolean;
	/**
	 * Return the next version to stamp a holder write with. Starts at acquiredAt; increments by
	 * the minimum monotonic step for every subsequent call so sequential saves on the same hold do
	 * not collide on version while still staying ≤ any concurrent write that happened after
	 * lock acquisition.
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
	const scope = options?.scope ?? 'cluster';
	if (scope !== 'cluster' && scope !== 'node')
		throw new ClientError(`Lock option scope must be 'cluster' or 'node', but received ${scope}`);
	return {
		lease: requireDuration('lease', options?.lease, DEFAULT_LOCK_LEASE_MS, MIN_LOCK_LEASE_MS, MAX_LOCK_LEASE_MS),
		timeout: requireDuration('timeout', options?.timeout, DEFAULT_LOCK_TIMEOUT_MS, 1, MAX_LOCK_TIMEOUT_MS),
		hold,
		scope,
		scopeRequested: options?.scope !== undefined,
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
let warnedClusterReleaseFailure = false;
function warnClusterReleaseFailure(err: unknown) {
	if (warnedClusterReleaseFailure) return;
	warnedClusterReleaseFailure = true;
	harperLogger.warn?.('cluster record lock release could not be written; peers will expire the hold', err);
}

class KeyLockHandle implements RecordLockHandle {
	store: any;
	key: any[];
	keyId: unknown;
	expiresAt: number;
	hold: boolean;
	released = false;
	expired = false;
	acquiredAt: number;
	clusterTsR: number | undefined;
	#lastHolderVersion: number | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	// Monotonic mirror of expiresAt. The wall-clock field stays public (callers and the cluster
	// protocol both speak in timestamps) but the enforcement compares monotonic readings, so neither
	// an NTP step nor a manual clock change can extend a lease past what peers assumed.
	#deadlineMono: number | undefined;
	#onRelease: (() => void) | undefined;

	constructor(store: any, key: any[], keyId: unknown, lease?: number, hold = false, acquiredAt?: number) {
		this.store = store;
		this.key = key;
		this.keyId = keyId;
		this.expiresAt = lease != null ? Date.now() + lease : Infinity;
		this.hold = hold;
		this.acquiredAt = acquiredAt ?? store.getMonotonicTimestamp();
		if (lease != null) {
			this.#deadlineMono = performance.now() + lease;
			this.#timer = setTimeout(() => this.#onLeaseExpire(), lease).unref();
		}
	}

	isExpired(): boolean {
		if (this.released || this.expired) return true;
		if (this.#deadlineMono !== undefined && performance.now() >= this.#deadlineMono) {
			// Run the expiry rather than only reporting it: the native key must actually go back so a
			// stalled holder does not keep a key every participant has already written off.
			this.#onLeaseExpire();
			return true;
		}
		return false;
	}

	joinClusterRound(tsR: number, leaseMs: number, onRelease: () => void): boolean {
		const remaining = tsR + leaseMs - Date.now();
		if (remaining <= 0) return false;
		this.clusterTsR = tsR;
		this.acquiredAt = tsR;
		this.#lastHolderVersion = undefined;
		this.#onRelease = onRelease;
		this.expiresAt = tsR + leaseMs;
		this.#deadlineMono = performance.now() + remaining;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.#onLeaseExpire(), remaining).unref();
		return true;
	}

	nextHolderVersion(): number {
		// TODO(harper#2412): under the settled dual-clock model the lock-ordered stamp belongs in the
		// distinct-version second word (HAS_DISTINCT_VERSION_FLAG), not the transaction timestamp.
		// Until that lands, Phase 1 keeps this Phase 0 mechanism, anchored at ts_R in cluster mode.
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
		clearTimeout(this.#timer);
		try {
			this.store.unlock(this.key);
		} catch (err) {
			if (!warnedLeaseTimerStores.has(this.store)) {
				warnedLeaseTimerStores.add(this.store);
				harperLogger.warn?.('record lock lease timer failed (store may have been dropped)', err);
			}
		}
		this.#emitRelease();
	}

	// The cluster release is a durability optimization, not the safety mechanism — peers expire the
	// hold on their own lease bound — so neither a throw nor a rejected promise may escape here. This
	// runs from a lease timer and from post-commit cleanup, where an escaping rejection would take
	// down the worker or turn a committed transaction into a 500.
	#emitRelease() {
		const onRelease = this.#onRelease;
		if (!onRelease) return;
		this.#onRelease = undefined;
		try {
			const result = onRelease() as unknown;
			if (result && typeof (result as Promise<void>).then === 'function')
				(result as Promise<void>).then(undefined, warnClusterReleaseFailure);
		} catch (err) {
			warnClusterReleaseFailure(err);
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
		this.#emitRelease();
		return true;
	}

	upgradeToHold(lease: number): void {
		this.hold = true;
		clearTimeout(this.#timer);
		// A granted cluster round may not be extended locally: peers bound the hold from the request
		// they saw, and a longer local lease is exactly the two-holder window this protocol removes.
		const extended = Date.now() + lease;
		this.expiresAt = this.clusterTsR === undefined ? extended : Math.min(extended, this.expiresAt);
		const remaining = this.expiresAt - Date.now();
		this.#deadlineMono = performance.now() + remaining;
		this.#timer = setTimeout(() => this.#onLeaseExpire(), remaining).unref();
		// Prime the nextHolderVersion counter so a later CLOSED-path save (e.g. after the
		// enclosing transaction commits) gets acquiredAt+MIN_STEP rather than acquiredAt again
		// — the same priming the fresh-hold path performs.  Without this, a post-commit save
		// and any in-transaction save both get acquiredAt, causing a LWW tie that drops the write.
		this.nextHolderVersion();
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
	if (existing && !existing.isExpired()) return existing;

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
