import { performance } from 'node:perf_hooks';
import harperLogger from '../utility/logging/harper_logger.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import { claimLocalKey, isValidFloor, timestampAbove } from './originClosedFloor.ts';
import * as envMngr from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { convertToMS } from '../utility/common_utils.ts';

/**
 * Exclusive per-record locks (harper#483).
 *
 * The intra-node authority is the rocksdb-js process-wide key lock: one `locks` map per DBDescriptor
 * shared by every worker thread's handle. Acquiring and releasing it write nothing to the store, and
 * the record's version and bytes are unchanged.
 *
 * Phase 1 layers cluster-wide exclusion on top without changing that: once the native key is held,
 * `Table.lock()` obtains a delegation for the key from its home node (see `recordLockCoordinator.ts`)
 * and calls `joinClusterRound()` on the handle. A live delegation serves repeat locks with no cluster
 * message at all. A node-scoped lock (`{ scope: 'node' }`) or a defaulted lock on a table declared
 * `replicate: false` skips the cluster step entirely and behaves exactly as it did in Phase 0; so does
 * a defaulted lock on a replicating table while no transport has ever been registered for the
 * database — once one has been, its absence fails closed (`isClusterLockRequired`).
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
	 * `'cluster'` is exclusive across every participating node; `'node'` keeps Phase 0 semantics and is
	 * exclusive only across this node's worker threads. Defaults to `'cluster'` on a replicating table
	 * and to `'node'` on a table declared `replicate: false`, which has no cluster to lock across.
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
 * `release()` is synchronous: it calls `store.unlock(key)` (or defers it while a commit hold
 * acquired via `retainForCommit` is still active), which is ownerless and fires any waiting
 * callbacks cross-thread. The lease timer sets `expired` in the holder thread when it fires
 * (while a commit hold is active, only the native unlock is deferred), so a stale holder cannot
 * accidentally call unlock after its lease already fired and released the key to a new holder.
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
	/**
	 * Raise the floor holder writes start from without treating it as a committed write: a caller
	 * timestamp, or the stamp above the state the lock was admitted on.
	 */
	noteCandidateFloor(version: number): void;
	/** Compute a holder-write version without advancing the floor until that write commits. */
	holderVersionCandidate(floor?: number): number;
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
	 * Whether the LEASE elapsed. Distinct from `isExpired()` in that a deliberate release does NOT
	 * make it true on its own: a write staged while the lock was held stays valid at commit if the
	 * caller merely unlocked. Once the deadline passes it is true either way, because by then peers
	 * have passed their own bound and the key may already belong to someone else.
	 */
	isLeaseExpired(): boolean;
	/** Revoke authority ahead of the lease, so a staged-but-uncommitted write is fenced at commit. */
	revokeLease(): void;
	/**
	 * Re-anchor a granted cluster round: the hold now runs from `tsR` (no margin, so this node
	 * always expires before any participant does) and `onRelease` emits the durable LOCK_RELEASE.
	 * Returns false when the round completed after the lease had already elapsed.
	 *
	 * `mintedMono` is `performance.now()` at the instant `tsR` was minted. The remaining lease is
	 * measured from it rather than from `tsR - Date.now()`: `tsR` comes from a never-decreasing
	 * monotonic source, so after a backward wall-clock step that subtraction would hand back MORE
	 * lease than the round was granted, past what every peer bounded from its own observation.
	 */
	joinClusterRound(tsR: number, leaseMs: number, mintedMono: number, onRelease: () => void): boolean;
	/**
	 * Return the next version to stamp a holder write with. Starts at acquiredAt when no transaction
	 * version has been noted; otherwise advances by the minimum monotonic step from the recorded floor.
	 */
	nextHolderVersion(): number;
	/** True when this call returned the native key; false if already released, or while a commit hold defers the unlock. */
	release(): boolean;
	/** Defer `store.unlock(key)` until an in-flight native commit settles or `holdDeadlineMono` expires. */
	retainForCommit?(holdDeadlineMono?: number): void;
	releaseCommitHold?(): void;
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

export function resolveLockOptions(
	options: RecordLockOptions | null | undefined,
	tableReplicates: boolean
): ResolvedRecordLockOptions {
	if (options != null && typeof options !== 'object')
		throw new ClientError(`Lock options must be an object, but received ${typeof options}`);
	const hold = options?.hold ?? false;
	if (typeof hold !== 'boolean') throw new ClientError(`Lock option hold must be a boolean, but received ${hold}`);
	const scope = options?.scope ?? (tableReplicates ? 'cluster' : 'node');
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

/**
 * The floor a newly admitted holder's writes start from: strictly above the version the lock reloaded
 * (a tombstone's included) and the highest predecessor log position the admission waited for. A bound
 * no valid timestamp exceeds fails the admission, rather than handing back a lock whose writes lose.
 */
export function admissionFloor(version: unknown, dependencyFloor: number | undefined): number | undefined {
	const aboveVersion = stampAbove(version);
	const aboveDependencies = stampAbove(dependencyFloor);
	return aboveVersion === undefined || aboveDependencies > aboveVersion ? aboveDependencies : aboveVersion;
}

function stampAbove(bound: unknown): number | undefined {
	if (!(typeof bound === 'number' && bound > 0)) return undefined;
	const above = timestampAbove(bound);
	if (!isValidFloor(above))
		throw new ClientError(
			`No valid timestamp is above ${bound}, so a write under this lock could not outrank the state it was admitted on`,
			409
		);
	return above;
}

const DEFAULT_MAX_LOCK_CLOCK_SKEW_MS = 5000;
let maxLockClockSkew: number | undefined;
const CLOCK_SKEW_WARN_INTERVAL_MS = 60_000;
let lastClockSkewWarn = -Infinity;

function maxLockClockSkewMs(): number {
	if (maxLockClockSkew !== undefined) return maxLockClockSkew;
	const configured = envMngr.get(CONFIG_PARAMS.STORAGE_MAXLOCKCLOCKSKEW);
	if (configured == null) return (maxLockClockSkew = DEFAULT_MAX_LOCK_CLOCK_SKEW_MS);
	const skew = typeof configured === 'string' || typeof configured === 'number' ? convertToMS(configured) : NaN;
	if (Number.isFinite(skew) && skew >= 0) return (maxLockClockSkew = skew);
	harperLogger.warn?.(
		`storage.maxLockClockSkew must be a finite, non-negative duration, but is ${configured}; using ${DEFAULT_MAX_LOCK_CLOCK_SKEW_MS}ms`
	);
	return (maxLockClockSkew = DEFAULT_MAX_LOCK_CLOCK_SKEW_MS);
}

/**
 * The stamp a new holder's writes start from, given its admission floor. A floor above `acquiredAt` is
 * the same for every holder admitted on state one transaction left, and as an explicit stamp it would
 * become each one's log key, so it is replaced by a key no other local append is issued: the clock's
 * next one, or, for a floor ahead of the clock within the configured skew, a claim that lifts every
 * later local key on this node above it. Past the skew the floor stays explicit and `movesClock` is
 * false, so one far-future timestamp pins neither this node's clock nor the holder's transaction.
 */
export function admissionStamp(
	rootStore: any,
	floor: number,
	acquiredAt: number
): { stamp: number; movesClock: boolean } {
	if (floor <= acquiredAt) return { stamp: floor, movesClock: true };
	const clock = rootStore.getMonotonicTimestamp();
	if (floor <= clock) return { stamp: clock, movesClock: true };
	const maxSkew = maxLockClockSkewMs();
	const skew = floor - clock;
	if (skew <= maxSkew) return { stamp: claimLocalKey(rootStore, floor), movesClock: true };
	const now = performance.now();
	if (now - lastClockSkewWarn >= CLOCK_SKEW_WARN_INTERVAL_MS) {
		lastClockSkewWarn = now;
		harperLogger.warn?.(
			`A record lock was admitted on state stamped ${Math.round(skew)}ms ahead of this node's clock, beyond storage.maxLockClockSkew (${maxSkew}ms); check clock synchronization. Its writes outrank that state only outside an explicit transaction, and their transaction log key may repeat another's.`
		);
	}
	return { stamp: floor, movesClock: false };
}

/** The advisory key for this (table, record) pair, distinct from getFromSource's bare-id single-flight lock. */
export function lockAttemptKey(tableId: number, id: any): any[] {
	return Array.isArray(id) ? [LOCK_KEY_PREFIX, tableId, ...id] : [LOCK_KEY_PREFIX, tableId, id];
}

const warnedLeaseTimerStores = new WeakSet();
/**
 * Rate-limited rather than latched, for the reason `warnOnce` in the coordinator gives: a release
 * that cannot be written leaves peers waiting out the lease, and a latch would show an operator the
 * first occurrence and then hide the condition for as long as it lasts.
 */
const CLUSTER_RELEASE_WARN_INTERVAL_MS = 60_000;
let lastClusterReleaseWarn = -Infinity;
function warnClusterReleaseFailure(err: unknown) {
	const now = performance.now();
	if (now - lastClusterReleaseWarn < CLUSTER_RELEASE_WARN_INTERVAL_MS) return;
	lastClusterReleaseWarn = now;
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
	#candidateFloor: number | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	// Monotonic mirror of expiresAt. The wall-clock field stays public (callers and the cluster
	// protocol both speak in timestamps) but the enforcement compares monotonic readings, so neither
	// an NTP step nor a manual clock change can extend a lease past what peers assumed.
	#deadlineMono: number | undefined;
	#onRelease: (() => void) | undefined;
	#commitHolds = 0;
	#deferredUnlock = false;
	#holdDeadlineMono: number | undefined;
	#holdTimer: ReturnType<typeof setTimeout> | undefined;

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

	noteHolderVersion(version: number): void {
		this.#lastHolderVersion = Math.max(this.#lastHolderVersion ?? version, version);
	}

	noteCandidateFloor(version: number): void {
		this.#candidateFloor = Math.max(this.#candidateFloor ?? version, version);
	}

	holderVersionCandidate(floor?: number): number {
		// The smallest step past the holder's last version: it prevents an exact LWW tie with that write
		// without materially moving past it.
		return Math.max(
			this.#lastHolderVersion != null ? timestampAbove(this.#lastHolderVersion) : this.acquiredAt,
			this.acquiredAt,
			this.#candidateFloor ?? -Infinity,
			floor ?? -Infinity
		);
	}

	isExpired(): boolean {
		return this.released || this.expired || this.#leaseLapsed();
	}

	isLeaseExpired(): boolean {
		return this.expired || this.#leaseLapsed();
	}

	// The single place the deadline is evaluated, so the two predicates cannot disagree about it. A
	// deliberate release does not make a lapsed lease valid again: by then peers have passed their own
	// bound and the key may belong to someone else.
	#leaseLapsed(): boolean {
		if (this.#deadlineMono === undefined || performance.now() < this.#deadlineMono) return false;
		// Finish the expiry rather than only reporting it: once no in-flight commit holds the handle,
		// the native key must go back so a stalled holder does not keep a key every participant has
		// already written off.
		if (!this.released) this.#onLeaseExpire();
		return true;
	}

	/**
	 * Revoke this handle's authority immediately, ahead of its lease. A recall must stop a delegate
	 * from COMMITTING, not merely from admitting: a caller that already staged a write and then called
	 * `unlock()` has nothing outstanding for a drain to wait on, but its write is still in the
	 * transaction and would land after the successor was admitted. Expiring the handle is what makes
	 * the commit-time fence reject it (§6).
	 */
	revokeLease(): void {
		if (this.expired) return;
		// `expired` is what the commit-time fence reads, and it must be set even when the caller has
		// ALREADY unlocked: a write staged before `unlock()` is still in its transaction, and that is
		// precisely the handoff §6 exists to fence. Gating this on `released` made the revocation a
		// no-op in the one state it was written for.
		this.expired = true;
		if (this.released) {
			// `release()` already ran (returning the native key or deferring the unlock onto an active
			// commit hold); only the fence flag and the lease timer are left to settle.
			clearTimeout(this.#timer);
			return;
		}
		this.#onLeaseExpire();
	}

	joinClusterRound(tsR: number, leaseMs: number, mintedMono: number, onRelease: () => void): boolean {
		// A round that completed after the native lease already fired yields no usable hold: the key
		// has gone back and another worker may hold it, so every write through this handle would 409.
		if (this.isLeaseExpired()) return false;
		const remaining = leaseMs - (performance.now() - mintedMono);
		if (remaining <= 0) return false;
		this.clusterTsR = tsR;
		this.acquiredAt = tsR;
		this.#lastHolderVersion = undefined;
		this.#onRelease = onRelease;
		this.expiresAt = tsR + leaseMs;
		// From the mint origin, not a second clock read: the design says this bound has no margin.
		this.#deadlineMono = mintedMono + leaseMs;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.#onLeaseExpire(), remaining).unref();
		return true;
	}

	nextHolderVersion(): number {
		// TODO(harper#2412): under the settled dual-clock model the lock-ordered stamp belongs in the
		// distinct-version second word (HAS_DISTINCT_VERSION_FLAG), not the transaction timestamp.
		// Until that lands, Phase 1 keeps this Phase 0 mechanism, anchored at ts_R in cluster mode.
		const next = this.holderVersionCandidate();
		this.#lastHolderVersion = next;
		return next;
	}

	retainForCommit(holdDeadlineMono?: number): void {
		if (this.released && !this.#deferredUnlock) return;
		this.#commitHolds++;
		if (holdDeadlineMono !== undefined && Number.isFinite(holdDeadlineMono)) {
			this.#holdDeadlineMono = Math.max(this.#holdDeadlineMono ?? holdDeadlineMono, holdDeadlineMono);
			if (this.#deferredUnlock) this.#armHoldTimer();
		}
	}

	releaseCommitHold(): void {
		if (this.#commitHolds <= 0) return;
		if (--this.#commitHolds === 0) {
			clearTimeout(this.#holdTimer);
			this.#holdTimer = undefined;
			this.#holdDeadlineMono = undefined;
			if (this.#deferredUnlock) {
				this.#deferredUnlock = false;
				this.#unlockAndEmitRelease('record lock deferred release failed (store may have been dropped)');
			}
		}
	}

	// True when the native key went back now; false when the unlock waits on the commit hold.
	#deferOrFlushUnlock(warningMessage: string): boolean {
		if (this.#holdDeadlineMono !== undefined && performance.now() >= this.#holdDeadlineMono) {
			this.#commitHolds = 0;
			this.#deferredUnlock = false;
			this.#holdDeadlineMono = undefined;
			clearTimeout(this.#holdTimer);
			this.#holdTimer = undefined;
			this.#unlockAndEmitRelease(warningMessage);
			return true;
		}
		this.#deferredUnlock = true;
		this.#armHoldTimer();
		return false;
	}

	#armHoldTimer() {
		clearTimeout(this.#holdTimer);
		this.#holdTimer = undefined;
		if (!this.#deferredUnlock || this.#holdDeadlineMono === undefined) return;
		const remaining = Math.max(0, Math.ceil(this.#holdDeadlineMono - performance.now()));
		this.#holdTimer = setTimeout(() => {
			this.#holdTimer = undefined;
			this.#commitHolds = 0;
			this.#holdDeadlineMono = undefined;
			if (this.#deferredUnlock) {
				this.#deferredUnlock = false;
				this.#unlockAndEmitRelease('record lock commit hold timer failed (store may have been dropped)');
			}
		}, remaining).unref();
	}

	#unlockAndEmitRelease(warningMessage: string) {
		try {
			this.store.unlock(this.key);
		} catch (err) {
			if (!warnedLeaseTimerStores.has(this.store)) {
				warnedLeaseTimerStores.add(this.store);
				harperLogger.warn?.(warningMessage, err);
			}
		}
		this.#emitRelease();
	}

	#onLeaseExpire() {
		if (this.released) return;
		this.released = true;
		this.expired = true;
		clearTimeout(this.#timer);
		if (this.#commitHolds > 0) {
			this.#deferOrFlushUnlock('record lock lease timer failed (store may have been dropped)');
			return;
		}
		this.#unlockAndEmitRelease('record lock lease timer failed (store may have been dropped)');
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
		if (this.#commitHolds > 0) {
			return this.#deferOrFlushUnlock('record lock release failed (store may have been dropped)');
		}
		this.#unlockAndEmitRelease('record lock release failed (store may have been dropped)');
		return true;
	}

	upgradeToHold(lease: number): void {
		this.hold = true;
		clearTimeout(this.#timer);
		// A granted cluster round may not be extended locally: peers bound the hold from the request
		// they saw, and a longer local lease is exactly the two-holder window this protocol removes.
		// Clamped on the monotonic deadline, not on expiresAt, so a backward wall-clock step cannot
		// turn the upgrade into the extension this is here to refuse.
		const now = performance.now();
		const extended = now + lease;
		const deadline = this.clusterTsR === undefined ? extended : Math.min(extended, this.#deadlineMono ?? extended);
		const remaining = deadline - now;
		this.#deadlineMono = deadline;
		this.expiresAt = Date.now() + remaining;
		this.#timer = setTimeout(() => this.#onLeaseExpire(), remaining).unref();
		// Prime the nextHolderVersion counter so a later CLOSED-path save (e.g. after the
		// enclosing transaction commits) gets a step past acquiredAt rather than acquiredAt again
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
