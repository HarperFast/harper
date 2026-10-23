import { cleanupUnusedBlobs, collectRetainedFileIds } from './blob.ts';
import type { Transaction as LMDBTransaction } from 'lmdb';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility.ts';
import {
	ClientError,
	DatabaseClosingError,
	DatabaseDrainTimeoutError,
	ReplicationConfirmationError,
	withoutReplicationUnconfirmed,
	ServerError,
	TransactionCommitConflictTimeoutError,
} from '../utility/errors/hdbError.ts';
import { lockNotHeldError, type RecordLockHandle } from './recordLock.ts';
import * as harperLogger from '../utility/logging/harper_logger.ts';
import type { Context, Id } from './ResourceInterface.ts';
import * as envMngr from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { convertToMS } from '../utility/common_utils.ts';
import { settleBeforeDeadline, when } from '../utility/when.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { Transaction as RocksTransaction, type Store as RocksStore, constants } from '@harperfast/rocksdb-js';
import { releaseLocalKey, reserveLocalKey, reservedLocalKey, transferLocalKey } from './originClosedFloor.ts';
const RETRY_NOW_VALUE = constants.RETRY_NOW_VALUE;
import type { RootDatabaseKind } from './databases.ts';
import { isReadOnlyMode, readOnlyModeError } from './readOnlyMode.ts';
import type { Entry } from './RecordEncoder.ts';
import { toBufferKey } from 'ordered-binary';
import { server } from '../server/Server.ts';
import {
	createLongLivedHolderReportBudget,
	describeHolderCandidates,
	finishLongLivedHolderReports,
	getReportThresholdMs,
	rebaseLongLivedTransactionReports,
	reportLongLivedHolder,
	type LongLivedHolderReportBudget,
} from './longLivedTransactions.ts';

const trackedTxns = new Set<DatabaseTransaction>();
const readTransactionOwners = new WeakMap<ReadTransaction, DatabaseTransaction>();
// Read options for a rotated generation's native transactions; shared because they never vary.
const SNAPSHOT_FREE = Object.freeze({ disableSnapshot: true });
const ONCE = Object.freeze({ once: true });
// Logical transactions the monitor supervises for their WRITES, kept apart from trackedTxns because the
// two have different units and different consumers: trackedTxns is per-link, bounds a read snapshot, and
// is what the read-queue-depth metric counts, while this holds one entry per logical transaction — the
// chain root — so a chain child can never become its own timeout root (issue #2231).
const supervisedWriteRoots = new Set<DatabaseTransaction>();
let MAX_OUTSTANDING_TXN_DURATION = convertToMS(envMngr.get(CONFIG_PARAMS.STORAGE_MAXTRANSACTIONQUEUETIME)) || 45000; // Allow write transactions to be queued for up to 45 seconds before we start rejecting them
const DEBUG_LONG_TXNS = envMngr.get(CONFIG_PARAMS.STORAGE_DEBUGLONGTRANSACTIONS);
export const TRANSACTION_STATE = {
	CLOSED: 0, // the transaction has been committed or aborted and can no longer be used for writes (if read txn is active, it can be used for reads)
	OPEN: 1, // the transaction is open and can be used for reads and writes
	// LMDB-only (LMDBTransaction.ts): committed while reads were outstanding, still usable for immediate
	// writes. The RocksDB path never enters this state — a commit with outstanding iterators replays its
	// writes onto a fresh transaction and commits immediately (see the outstanding-iterators branch in
	// commit()), going straight to CLOSED.
	LINGERING: 2,
};
const MAX_RETRIES = 40;
// Over-limit monitor ticks a transaction parked in its commit phase is spared before it is aborted
// like any other over-time transaction. Sparing re-arms `timeout`, so each of these costs two
// monitor intervals — roughly 10 minutes at the 30s default. Generous, so a legitimately large blob
// write finishes, but bounded, so a pre-commit source that stalls instead of finishing can't pin its
// read snapshot forever (issue #2062).
export const COMMIT_PHASE_GRACE = 10;
// Cap the per-retry backoff so replication-applied transactions, which retry conflicts without a
// cap (see the commit rejection handler), don't grow the delay unbounded.
let MAX_RETRY_DELAY_MS = 1000;
// Every native write commit currently outstanding on this worker thread, oldest first.
// checkOverloaded() sheds new application writes once the OLDEST of these has been outstanding
// past MAX_OUTSTANDING_TXN_DURATION, so a commit whose promise never settles (harper#2001) is
// detected whichever transaction submitted it. A linked list rather than a Set because the write
// path reads the oldest on every write and must not allocate an iterator to do it, and because
// commits settle out of order and so have to unlink in constant time.
interface OutstandingCommit {
	start: number;
	prev: OutstandingCommit | undefined;
	next: OutstandingCommit | undefined;
	commitResolution: Promise<number | void>;
	// Identity for the one-time checkOverloaded() log below (harper#2001) — otherwise a stuck commit
	// gives no indication of which database/table/resource to investigate. Snapshotted at arm time
	// (not read from `this.writes`/`this.startedFrom` lazily off the DatabaseTransaction object)
	// because that object can be reused for a later immediate commit while this native commit is
	// still wedged — its resolve handler runs clearWrites() on the SAME object, which would blank or
	// replace the identity out from under a deferred read. Per-node (not a single module-level slot)
	// so that every outstanding commit carries its own identity and its own `logged` flag: a second
	// commit that is still stuck once the first settles becomes the new oldest and logs on its own.
	store: any;
	rootStore: any;
	startedFrom: { resourceName: string; method: string } | undefined;
	nativeTransaction: any;
	logged: boolean;
}
let oldestOutstandingCommit: OutstandingCommit | undefined;
let newestOutstandingCommit: OutstandingCommit | undefined;
let outstandingCommitCount = 0;
const suspendedDatabaseCommits = new WeakMap<object, number>();
const permanentlySuspended = Symbol('permanentlySuspendedDatabaseCommits');
let suspendedDatabaseRootCount = 0;
let hasPermanentlySuspendedDatabaseRoots = false;
// Caps the stuck-commit log (checkOverloaded() below) to at most one line per this interval across
// the whole thread, regardless of how many distinct commits individually cross the threshold — see
// the comment at the log site for why a per-commit-only dedup isn't enough under sustained overload.
const OVERLOAD_LOG_MIN_INTERVAL_MS = 1000;
// One cooldown per reporting site, not one shared: `shed` fires on every bystander write during a
// wedge and would starve `abandon`, which names a different transaction and is the only server-side
// record of why a request was failed. Mutates only when it grants, so a caller with its own
// suppression as well (checkOverloaded's per-node `logged`) must test that first.
const lastStuckCommitLogAt = { shed: -Infinity, abandon: -Infinity, overdue: -Infinity };
let lastOverloadStatusAt = -Infinity;
function allowStuckCommitLog(site: 'shed' | 'abandon' | 'overdue', now: number): boolean {
	if (now - lastStuckCommitLogAt[site] <= OVERLOAD_LOG_MIN_INTERVAL_MS) return false;
	lastStuckCommitLogAt[site] = now;
	return true;
}
/** Test seam: clears the stuck- and stalled-commit log cooldowns so consecutive tests can assert on log emission without sleeping. */
export function resetStuckCommitLogCooldownForTests(): void {
	lastStuckCommitLogAt.shed = -Infinity;
	lastStuckCommitLogAt.abandon = -Infinity;
	lastStuckCommitLogAt.overdue = -Infinity;
	lastStalledCommitWarningAt = -Infinity;
	lastStalledCommitErrorAt = -Infinity;
}

// Which database/table, which native transaction, and which request a stuck commit belongs to —
// without it a wedge gives no indication of what to investigate (harper#2001).
export function describeCommitIdentity(
	store: any,
	startedFrom: { resourceName: string; method: string } | undefined,
	nativeTransaction: any,
	rootStore = store?.rootStore
): string {
	// `.id` is a native accessor that can throw on an already-closed handle (rocksdb-js); this is a
	// diagnostic on the failure path and must never itself become the failure.
	let nativeTransactionId;
	try {
		nativeTransactionId = nativeTransaction?.id;
	} catch {}
	return (
		`from table: ${rootStore?.databaseName ?? '?'}.${store?.name ?? '?'}` +
		(nativeTransactionId !== undefined ? ` (transaction ${nativeTransactionId})` : '') +
		(startedFrom?.resourceName
			? `, started from ${startedFrom.resourceName}${startedFrom.method ? '.' + startedFrom.method : ''}`
			: '')
	);
}

// Track a submitted commit until it settles. Every attempt is tracked unconditionally: a
// coordinated retry round and a chained second-store commit are both issued from inside the
// preceding commit's own resolve handler, which runs before any reaction that could release a
// single shared slot — so anything conditional on "is something already outstanding" skips them
// and leaves a wedged retry or chain invisible to checkOverloaded() forever. Each attempt is timed
// from its own submission, keeping the overload window per-attempt rather than cumulative over a
// retry ladder. `.then(untrack, untrack)` also marks an ERR_BUSY rejection handled, so this
// tracking never surfaces as an unhandled rejection alongside the caller's own handler.
// Exported so raw RocksDB writers and unit tests share the same queue. The unlink order that matters
// (a middle or tail node settling first) cannot be forced through real writes, and a node left linked
// would 503 every write on this thread forever.
// Also the single source for write-queue-depth accounting (getTransactionQueueDepths below): every
// native commit this function tracks is, by definition, exactly the write-queue backlog — see the
// comment there for why that used to be a second, separately-maintained counter.
// `store`/`startedFrom`/`nativeTransaction` are the identity snapshot for checkOverloaded()'s stuck-
// commit log (harper#2001); omit them (as the test seam below does) when a caller has none to give.
export function trackOutstandingCommit(
	commitResolution: Promise<number | void>,
	store?: any,
	startedFrom?: { resourceName: string; method: string },
	nativeTransaction?: any,
	rootStore = store?.rootStore
): void {
	// Guards against a future caller passing a non-Promise: today commit() always hands this a real
	// Promise, but an unguarded link here would leave a node permanently wedged in the list (503ing
	// every write on this thread) with no settlement to ever unlink it.
	if (typeof commitResolution?.then !== 'function') return;
	const outstanding: OutstandingCommit = {
		start: performance.now(),
		prev: newestOutstandingCommit,
		next: undefined,
		commitResolution,
		store,
		rootStore,
		startedFrom,
		nativeTransaction,
		logged: false,
	};
	if (newestOutstandingCommit != null) newestOutstandingCommit.next = outstanding;
	else oldestOutstandingCommit = outstanding;
	newestOutstandingCommit = outstanding;
	outstandingCommitCount++;
	// Doubles as the write-queue-depth high-water mark (see getTransactionQueueDepths): every
	// outstanding commit is a write-queue entry, so the peak of one is the peak of the other.
	if (outstandingCommitCount > writeTxnQueueDepthHighWater) writeTxnQueueDepthHighWater = outstandingCommitCount;
	// Guards against double-untracking the same node: `.then(untrack, untrack)` below means a promise
	// that both resolves and later has its rejection handler independently triggered (or is tracked via
	// a shared/misused resolution) could otherwise run the unlink twice, corrupting the list or driving
	// outstandingCommitCount negative.
	let untracked = false;
	const untrack = () => {
		if (untracked) return;
		untracked = true;
		if (outstanding.prev != null) outstanding.prev.next = outstanding.next;
		else oldestOutstandingCommit = outstanding.next;
		if (outstanding.next != null) outstanding.next.prev = outstanding.prev;
		else newestOutstandingCommit = outstanding.prev;
		outstandingCommitCount--;
	};
	commitResolution.then(untrack, untrack);
}

export function databaseCommitsSuspended(rootStore: object | undefined): boolean {
	if (rootStore == null) return false;
	if ((rootStore as any).status === 'closed') return true;
	if (suspendedDatabaseRootCount === 0 && !hasPermanentlySuspendedDatabaseRoots) return false;
	if ((rootStore as any)[permanentlySuspended]) return true;
	return suspendedDatabaseRootCount > 0 && (suspendedDatabaseCommits.get(rootStore) ?? 0) > 0;
}

/** Keep abandoned root wrappers fenced without retaining the process-wide active-fence counter. */
export function permanentlySuspendDatabaseCommits(rootStores: Iterable<object>): void {
	for (const rootStore of rootStores) {
		if ((rootStore as any)[permanentlySuspended]) continue;
		const suspension = suspendedDatabaseCommits.get(rootStore) ?? 0;
		if (suspension > 0) suspendedDatabaseRootCount--;
		suspendedDatabaseCommits.delete(rootStore);
		(rootStore as any)[permanentlySuspended] = true;
		hasPermanentlySuspendedDatabaseRoots = true;
	}
}

export function getSuspendedDatabaseRootCount(): number {
	return suspendedDatabaseRootCount;
}

export function commitTrackedRocksTransaction(
	transaction: RocksTransaction,
	store: any,
	rootStore = store?.rootStore
): Promise<number | void> {
	if (databaseCommitsSuspended(rootStore)) {
		releaseLocalKey(transaction);
		try {
			transaction.abort();
		} catch {}
		return Promise.reject(new DatabaseClosingError(rootStore?.databaseName ?? rootStore?.path ?? 'unknown'));
	}
	let commitResolution: Promise<number | void>;
	try {
		commitResolution = transaction.commit() as Promise<number | void>;
	} catch (error) {
		releaseLocalKey(transaction);
		return Promise.reject(error);
	}
	// A raw handle never recommits after a failure (its callers retry on a fresh handle), so either
	// outcome ends its reservation.
	const release = () => releaseLocalKey(transaction);
	commitResolution.then(release, release);
	trackOutstandingCommit(commitResolution, store, undefined, transaction, rootStore);
	return commitResolution;
}

let databaseCommitDrainTimeoutMilliseconds = 120_000;

export function getDatabaseCommitDrainTimeoutMilliseconds(): number {
	return databaseCommitDrainTimeoutMilliseconds;
}

export function setDatabaseCommitDrainTimeoutMilliseconds(timeoutMilliseconds: number): number {
	const previous = databaseCommitDrainTimeoutMilliseconds;
	databaseCommitDrainTimeoutMilliseconds = timeoutMilliseconds;
	return previous;
}

/**
 * Stop new native commits for these database roots and wait for submissions already in flight.
 * The returned release is reference-counted and idempotent so overlapping lifecycle operations
 * cannot reopen commit admission underneath each other.
 */
export function suspendDatabaseCommits(rootStores: Iterable<object>): {
	waitForDrain(options?: { deadline?: number; databaseName?: string }): Promise<void>;
	release(): void;
} {
	const roots = [...new Set(rootStores)];
	const rootSet = new Set(roots);
	for (const rootStore of roots) {
		if ((rootStore as any)[permanentlySuspended]) continue;
		const count = suspendedDatabaseCommits.get(rootStore) ?? 0;
		if (count === 0) suspendedDatabaseRootCount++;
		suspendedDatabaseCommits.set(rootStore, count + 1);
	}
	let released = false;
	return {
		async waitForDrain(options = {}) {
			const timeoutMilliseconds =
				options.deadline === undefined
					? databaseCommitDrainTimeoutMilliseconds
					: Math.max(0, options.deadline - Date.now());
			const deadline = options.deadline ?? Date.now() + timeoutMilliseconds;
			for (;;) {
				const pending: Promise<number | void>[] = [];
				for (let outstanding = oldestOutstandingCommit; outstanding; outstanding = outstanding.next) {
					if (rootSet.has(outstanding.rootStore)) pending.push(outstanding.commitResolution);
				}
				if (pending.length === 0) return;
				await settleBeforeDeadline(
					pending,
					deadline,
					() =>
						new DatabaseDrainTimeoutError(
							options.databaseName ?? (roots[0] as any)?.databaseName ?? (roots[0] as any)?.path ?? 'unknown',
							timeoutMilliseconds
						)
				);
			}
		},
		release() {
			if (released) return;
			released = true;
			for (const rootStore of roots) {
				if ((rootStore as any)[permanentlySuspended]) continue;
				const count = suspendedDatabaseCommits.get(rootStore) ?? 0;
				if (count <= 1) {
					suspendedDatabaseCommits.delete(rootStore);
					suspendedDatabaseRootCount--;
				} else suspendedDatabaseCommits.set(rootStore, count - 1);
			}
		},
	};
}

/**
 * How many write commits are outstanding on this thread and how long the oldest has been waiting
 * (`oldestAgeMs` is undefined when none is). `oldestAgeMs` is exactly the value checkOverloaded()
 * rejects on, exposed so a commit that never settles (harper#2001) can be observed directly rather
 * than inferred from the 503s it eventually produces.
 */
export function getOutstandingCommits(): { count: number; oldestAgeMs: number | undefined } {
	return {
		count: outstandingCommitCount,
		oldestAgeMs: oldestOutstandingCommit ? performance.now() - oldestOutstandingCommit.start : undefined,
	};
}
// Once per process: committing under open read iterators forces a write replay, so the warning is
// about the caller's pattern, not the individual commit.
let replayedWritesWarned = false;

function writesRemoteOrigin(operation: TransactionWrite): boolean {
	if (operation.nodeId === undefined) return false;
	const auditStore: any = operation.store.rootStore?.auditStore;
	const relayed = operation.viaNodeId !== undefined && operation.viaNodeId !== operation.nodeId;
	return auditStore?.isLocalOrigin?.(operation.nodeId, relayed) === false;
}

/**
 * Abort a detached native handle. RocksTransaction.abort() throws on one that was already
 * committed or aborted, and every caller is a cleanup path whose own callers have no handler — a
 * throw there would abandon the rest of the cleanup.
 */
function abortNativeTransaction(
	transaction: RocksTransaction | null | undefined,
	context: string,
	store?: any,
	startedFrom?: { resourceName: string; method: string }
): void {
	if (transaction == null) return;
	const txn = transaction as RocksTransactionWithRetry;
	if (txn.abortedByWrapper || txn.committed || txn.commitInFlight) return;
	txn.abortedByWrapper = true;
	releaseLocalKey(transaction);
	try {
		transaction.abort();
	} catch (error) {
		if ((error as any)?.code === 'ERR_TRANSACTION_ABANDONED') {
			harperLogger.error?.(
				`Aborted a transaction with a durable log entry (${context}), ${describeCommitIdentity(store, startedFrom, transaction)}`,
				error
			);
		} else {
			harperLogger.debug?.(context, error);
		}
	}
}

// The analytics module registers a recorder here at load (dependency inversion, mirroring
// `replicationConfirmation` below) so the storage layer doesn't statically import the analytics/server
// modules. Unset until analytics loads, and when analytics is disabled the recorder call is cheap.
let recordCommitLatencyMs: ((durationMs: number) => void) | undefined;
export function setCommitLatencyRecorder(recorder: ((durationMs: number) => void) | undefined) {
	recordCommitLatencyMs = recorder;
}

// Emit the submit→settle duration of a write commit as the `transaction-commit-time` distribution
// metric. Recorded on both fulfilment and rejection since a slow-then-failed commit still consumed
// queue time. The recorder is wrapped so it can never throw — a metrics failure must neither break the
// commit nor surface as an unhandled rejection on this floating `.then`. The thenable guard protects
// against a future caller passing a non-Promise `commitResolution` (today it is always the rocksdb-js
// async `Transaction.commit()` result, which is guaranteed to be a Promise). The parameter matches
// `commit()`'s honest `Promise<number | void>` result (the coordinated-retry sentinel); the resolved
// value is intentionally ignored — only the settle timing is recorded.
function recordCommitLatency(commitResolution: Promise<number | void>, submittedAt: number) {
	if (!recordCommitLatencyMs) return;
	const record = () => {
		try {
			recordCommitLatencyMs(performance.now() - submittedAt);
		} catch {
			// analytics recording is best-effort and must never disturb the commit path
		}
	};
	if (commitResolution && typeof (commitResolution as any).then === 'function') {
		commitResolution.then(record, record);
	}
}

// Queue-depth gauges surfaced through the analytics pipeline (write-transaction-queue-depth /
// read-transaction-queue-depth). Per-thread state; the analytics aggregator sums across threads.
// The write depth is `outstandingCommitCount` itself (maintained above by trackOutstandingCommit) —
// write commits handed to the storage engine but not yet resolved are exactly the same set of native
// commits the overload check tracks, and keeping one counter instead of two removes the duplicate
// per-commit bookkeeping (and the drift risk: a code path that updates one but not the other, as the
// replay path did before this fix). Read depth is derived from the live `trackedTxns` set (every
// tracked transaction holds an open read snapshot). We also retain a high-water mark per sampling
// window because the queue can fill and drain within a single (~1s) analytics period, so an
// instantaneous sample taken at emit time would routinely miss the spike operators need to see.
// RocksDB-write-path only: LMDB routes through the separate LMDBTransaction.commit()/getReadTxn()
// overrides (resources/LMDBTransaction.ts), which maintain their own unrelated `trackedTxns` set and
// do not call into this accounting.
let writeTxnQueueDepthHighWater = 0;
let readTxnQueueDepthHighWater = 0;

/**
 * Returns the current write/read transaction queue depths for this thread along with the high-water
 * mark observed since the previous call, then resets the high-water marks to the current depth so the
 * next sampling window starts fresh. Consumed by the analytics writer (see analytics/write.ts).
 */
export function getTransactionQueueDepths() {
	// `readTxnQueueDepthHighWater` is maintained at the single trackedTxns growth site, so it already
	// dominates the current size here — no need to reconcile against `readDepth` before reporting.
	const readDepth = trackedTxns.size;
	const depths = {
		writeDepth: outstandingCommitCount,
		writeMaxDepth: writeTxnQueueDepthHighWater,
		readDepth,
		readMaxDepth: readTxnQueueDepthHighWater,
	};
	writeTxnQueueDepthHighWater = outstandingCommitCount;
	readTxnQueueDepthHighWater = readDepth;
	return depths;
}

// a residency id names one list for the life of its database, so its residents are resolved once
const residentsByResidencyId = new WeakMap<object, Map<number, string[]>>();
const MAX_CACHED_RESIDENCIES = 10_000;

// BigInt.toJSON throws (and runs before any JSON.stringify replacer)
const describeKey = (key: Id): string =>
	Array.isArray(key)
		? `[${key.map(describeKey).join(',')}]`
		: typeof key === 'bigint'
			? String(key)
			: JSON.stringify(key);

export function confirmingResidents(store: any, residencyId: number, confirmationCount: number, key: Id): string[] {
	const dbisDb = store.rootStore.dbisDb;
	let residentsById = residentsByResidencyId.get(dbisDb);
	if (!residentsById) residentsByResidencyId.set(dbisDb, (residentsById = new Map()));
	let residents = residentsById.get(residencyId);
	if (!residents) {
		if (residentsById.size >= MAX_CACHED_RESIDENCIES) residentsById.clear();
		const residency: string[] | undefined = dbisDb.getSync([Symbol.for('residency_by_id'), residencyId]);
		residents = Object.freeze(
			residency ? Array.from(new Set(residency)).filter((name) => name !== server.hostname) : []
		) as string[];
		if (residency) residentsById.set(residencyId, residents);
	}
	if (confirmationCount > residents.length) {
		throw new ClientError(
			`Cannot confirm replication to ${confirmationCount} node(s) for record ${describeKey(key)} in database "${store.rootStore.databaseName}": it is resident on ${residents.length} other node(s)${residents.length ? ` (${residents.join(', ')})` : ''}`
		);
	}
	return residents;
}

let confirmReplication;
let confirmationFeasibility:
	((databaseName: string, confirmationCount: number, residentPeerLists?: string[][]) => void) | undefined;
/**
 * Register the replication layer's confirmation waiter, and optionally a check that runs before native
 * submission and throws when the requested confirmation can never be met, so the write never lands.
 */
export function replicationConfirmation(callback, feasibility?: typeof confirmationFeasibility) {
	confirmReplication = callback;
	confirmationFeasibility = feasibility;
}

export function confirmReplicationAfterCommit(callback: () => unknown): Promise<void> {
	let result;
	try {
		result = callback();
	} catch (error) {
		result = Promise.reject(error);
	}
	const confirmation = Promise.resolve(result).then(
		() => {},
		(error) => {
			throw new ReplicationConfirmationError(error);
		}
	);
	confirmation.catch(() => {});
	return confirmation;
}

export function settleCommitCompletions(completions: unknown[], confirmation?: Promise<void>): Promise<void> {
	if (completions.length === 0) return confirmation ?? Promise.resolve();
	let deferredConfirmationError: ReplicationConfirmationError;
	const localCompletions = completions.map((completion) =>
		Promise.resolve(completion).catch((error) => {
			if (error instanceof ReplicationConfirmationError) deferredConfirmationError ??= error;
			else throw error;
		})
	);
	// A confirmation failure must not abort a chained local commit that has yet to land.
	return Promise.all(localCompletions).then(() => {
		if (deferredConfirmationError) throw deferredConfirmationError;
		return confirmation;
	});
}
let txnExpiration = envMngr.get(CONFIG_PARAMS.STORAGE_MAXTRANSACTIONOPENTIME) ?? 30000;

class StartedTransaction extends Error {}

/**
 * Built when the long-transaction monitor aborts a write-bearing transaction that stayed open past the
 * limit (STORAGE_MAXTRANSACTIONOPENTIME). Surfacing this instead of silently force-committing a partial
 * write set preserves atomicity and avoids the index corruption described in issue #1407: the
 * application gets an actionable error and owns how it splits long-running work into smaller
 * transactions, while core keeps the consistency guarantee.
 */
export function transactionOpenTooLongError(): ServerError {
	// 422 rather than 503: the condition is deterministic for a given transaction shape, so a retryable
	// status (503/408) would invite clients and gateways to auto-retry the same doomed long transaction.
	// 422 signals the request itself must change (split the work), which is the actionable response.
	return new ServerError(
		'Transaction was aborted after exceeding the maximum open-transaction time; split long-running work into smaller transactions',
		422
	);
}

class ReadSnapshotExpiredError extends ServerError {
	constructor() {
		super('Read scan snapshot expired; retry the read without replaying previously committed writes', 503);
		this.name = 'ReadSnapshotExpiredError';
	}
}

export function getReadTransactionGuard(transaction: ReadTransaction): (() => void) | undefined {
	const owner = readTransactionOwners.get(transaction);
	if (!owner) return;
	return function checkActive() {
		if (owner.timedOut) throw transactionOpenTooLongError();
		if (owner.transaction !== transaction) {
			throw new ReadSnapshotExpiredError();
		}
	};
}

export function trackReadRange(transaction: ReadTransaction, createRange: () => any): any {
	const owner = readTransactionOwners.get(transaction);
	if (!owner) return createRange();
	const checkActive = getReadTransactionGuard(transaction)!;
	checkActive();
	const range = createRange();
	const iterate = range.iterate;
	range.iterate = function (options) {
		const iterator = iterate.call(this, options);
		let done = false;
		// Closing the underlying iterator is the one step here that can throw for a reason the caller
		// must not see: `next()` only reaches it once the snapshot is already gone, which is the
		// likeliest moment for the native layer to object, and an error from cleanup would replace the
		// named 503 with exactly the raw iterator error this wrapper exists to stop surfacing. The
		// closure reference rather than `this` so a destructured `next` still cleans up.
		const wrapper = {
			[Symbol.iterator]() {
				return this;
			},
			next() {
				if (done) return { done: true, value: undefined };
				try {
					checkActive();
					owner.rangeReadActive = true;
					const result = iterator.next();
					done = result.done === true;
					return result;
				} catch (error) {
					closeQuietly();
					throw error;
				}
			},
			return(value?: any) {
				if (!done) {
					done = true;
					iterator.return?.(value);
				}
				return { done: true, value };
			},
			throw(error) {
				// Not delegated to `iterator.throw`: it closes and rethrows the same error anyway, and
				// delegating after the close below would run it against an iterator already closed.
				closeQuietly();
				throw error;
			},
		};
		function closeQuietly() {
			try {
				wrapper.return();
			} catch {
				// the error being propagated is the actionable one
			}
		}
		return wrapper;
	};
	return range;
}

export function requestAbortedError(): ServerError {
	// 499 (client closed request) rather than a retryable 503/408: no client is left to retry.
	return new ServerError('Transaction was aborted because the client disconnected', 499);
}

type MaybePromise<T> = T | Promise<T>;

/**
 * A search result set holding a read reference on a transaction. `onDone` returns that reference and
 * clears itself, so calling it more than once is safe.
 */
export type OwnedReadIterator = { onDone?: (() => void) | null };

export type CommitOptions = {
	doneWriting?: boolean;
	timestamp?: number;
	retries?: number;
	flush?: boolean;
	transaction?: RocksTransaction;
	/**
	 * Internal: this call continues a commit attempt already under way on this chain (the extra-writes
	 * recursion, or the head's cascade into `next`) rather than starting a new one. It is what lets a
	 * poison that landed mid-attempt spare the rest of that attempt without also sparing a genuinely
	 * fresh commit issued while it is still running.
	 */
	continuation?: boolean;
};

type ReadTransaction = (LMDBTransaction | RocksTransaction) & {
	openTimer?: number;
	retryRisk?: number;
	isDone?: boolean;
	isCommitted?: boolean;
};

export type WriteGeneration = {
	closed: boolean;
	internalWrites: number;
};

export type TransactionWrite = {
	key: Id;
	store: any; // using any here because of circular dependency and complex RootDatabaseKind
	invalidated?: boolean;
	entry?: Partial<Entry>;
	before?: () => void | Promise<void>;
	beforeIntermediate?: () => void | Promise<void>;
	commit?: (
		txnTime: number,
		existingEntry: Partial<Entry>,
		retry: boolean,
		transaction: any,
		committedBy?: DatabaseTransaction
	) => MaybePromise<void>;
	// Once a write has been taken over, the transaction committing it is not the one that staged it, and
	// overload accounting, the replay marker and a no-op write's removal all belong to the committer.
	validate?: (txnTime: number, committedBy: DatabaseTransaction) => void;
	fullUpdate?: boolean;
	// The origin record version carried by an applied or replayed write. Bound it by the origin's
	// transaction-log key so malformed or historical overloaded values cannot move ordering past the write.
	recordVersion?: number;
	saved?: boolean;
	deferSave?: boolean;
	skipReplicationConfirmation?: boolean;
	nodeName?: string;
	nodeId?: number;
	viaNodeId?: number;
	promise?: Promise<any>;
	result?: any;
	// blobs that were pre-saved as part of this write; used to clean up files if the commit is skipped or aborted
	savedBlobs?: Blob[];
	// this round staged neither a record nor an audit entry. An earlier durable audit entry may
	// still own savedBlobs. Reset at the top of each commit-handler invocation.
	skipped?: boolean;
	// sticky: a non-isRetry staging of this write appended its audit entry (set in save(); the retry
	// dedup guards in the commit handler read it to ignore the write's own orphaned entry)
	appendedAuditEntry?: boolean;
	// the transaction holding this write in its `writes` (set in addWrite). A deferred write's save() is
	// only its trigger, so it can be triggered after the context has moved on to another transaction;
	// this is who commits it when the transaction current at that point is not a scope (#2292).
	stagedIn?: DatabaseTransaction;
	// the preceding write to the same store and key in this transaction, if any (linked in addWrite)
	priorWrite?: TransactionWrite;
	keyId?: unknown;
	// set only by a write that BOTH reads priorStagedWrite() and publishes stagedEntry; addWrite orders
	// those against earlier same-key writes. A write that does one or neither would be ordered against a
	// basis it cannot consume.
	chainsStagedState?: boolean;
	// addWrite's chain-walk memo: nearest earlier same-key write unsaved at staging time (null = none)
	pendingPriorWrite?: TransactionWrite | null;
	// what this write left for its key in this transaction, once its commit handler stored it (a
	// deletion stages an entry with no value). Reset at the top of each commit-handler invocation so
	// a retry round that takes an early return doesn't leave the prior round's state behind.
	stagedEntry?: Partial<Entry>;
	// a later write to the same key in this transaction replaced (or deleted) the record this write
	// stored, so blobs this write saved are only reachable through its audit entry. Reset per
	// commit-handler round, like stagedEntry.
	superseded?: boolean;
	// Audit pruning owns blobs referenced by an appended audit entry once its handle commits or
	// has a durable log; a staged entry in an unsubmitted handle owns none.
	blobsAuditReferenced?: boolean;
	// Lock handle set by Table._writeUpdate when the write is staged through a held record lock;
	// used in DatabaseTransaction.save() to assign and track that handle's write versions.
	lockHandle?: RecordLockHandle;
	// Per-operation holder version, set once on first save() and reused on retry so each lock write
	// keeps its own candidate version across retries instead of falling back to stagedTxnTime or an
	// explicit this.timestamp shared on the transaction.
	lockStamp?: number;
	// Version staged by a write that actually changed the record this round. It advances any
	// same-key held handle's floor only after the native transaction commits successfully.
	appliedRecordVersion?: number;
	// Present only while a transaction owns record locks, keeping bookkeeping off ordinary writes.
	trackRecordVersion?: boolean;
	// Set by a table commit handler only when this retry round staged a record change.
	recordVersionApplied?: boolean;
	// Set by DatabaseTransaction.save() on the immediateCommit path: the Promise returned by the
	// inner this.commit({ transaction }) call. The ImmediateTransaction outer commit resolves before
	// this settles (fire-and-forget from the if-branch), so Table.save()'s lock-writable path awaits
	// it to ensure the write is durable before resolving to the caller.
	innerCommit?: MaybePromise<CommitResolution>;
	// the commit derives stored state (folds, index diffs, residency) from its base entry, so
	// save() must reload that base through the committing transaction's snapshot
	reloadCommitBase?: boolean;
	// of the audit entry this write appended; a coordinated retry appends nothing and keeps it, so
	// confirmation counts the residents the replicated entry names
	residencyId?: number;
	appendedTo?: RocksTransaction;
	stagedOn?: RocksTransaction;
	baseReadTxn?: any;
	writeGeneration?: WriteGeneration;
	instanceClosed?: boolean;
};

export function closeWriteInstance(operation: TransactionWrite | null | undefined): void {
	if (operation && !operation.instanceClosed) {
		operation.instanceClosed = true;
		if (operation.writeGeneration) operation.writeGeneration.closed = true;
	}
}

export function validateWrite(operation: TransactionWrite, txnTime: number, transaction: DatabaseTransaction): any {
	const generation = operation.writeGeneration;
	if (generation) generation.internalWrites++;
	try {
		return operation.validate?.(txnTime, transaction);
	} finally {
		if (generation) generation.internalWrites--;
	}
}

export function getAppliedWriteVersion(recordVersion: number | undefined, txnLogKey: number): number {
	return recordVersion == null ? txnLogKey : Math.min(recordVersion, txnLogKey);
}

/**
 * The state a preceding write in this transaction left for `operation`'s key, or undefined if this
 * is the first write to it. Within a transaction the writes are ordered by program order, and
 * neither storage engine can serve that state to a read — LMDB applies staged writes only in the
 * commit batch — so a later write to the same key gets its basis from the write that staged it
 * rather than from a pre-transaction read (harper#1968). Walks past writes that staged nothing
 * (a skipped or non-record write) to the last one that did, returning the owning write.
 */
export function priorStagedWrite(operation: TransactionWrite): TransactionWrite | undefined {
	for (let prior = operation.priorWrite; prior; prior = prior.priorWrite) {
		if (prior.stagedEntry) return prior;
	}
}

/**
 * Key identity for the per-key write chain, which must match the storage engines' key identity —
 * and that identity is the ordered-binary encoding, not JS value identity. The mismatches run in
 * both directions: `1n` and `1` (or `2**60` and `1n << 60n`) encode to the SAME stored key, so the
 * chain must link them or repeat writes re-introduce the harper#1968 stale basis; while `[0]` vs
 * `[-0]` and `[null]` vs `[NaN]` are DIFFERENT stored keys that value-ish encodings (JSON, string
 * coercion) collapse, cross-contaminating unrelated records. So every key is mapped through the
 * same encoder the stores use; latin1 keeps the bytes injective in a string. Symbol keys (internal
 * metadata writes) can't be key-encoded and keep native identity. Null is reserved for topic-less
 * publishes and audit-only markers.
 */
export function writeKeyId(key: Id): unknown {
	if (typeof key === 'symbol' || key == null) return key;
	return toBufferKey(key as any).toString('latin1');
}

function clearAttemptState(txn: DatabaseTransaction): void {
	txn.poisonedMidCommit = false;
	txn.postSubmitPoisoned = false;
	txn.stalledCommitResourcesReleased = false;
}

// Returned by takeCompletions() when nothing is staged; only its length is read before Promise.all.
const NO_COMPLETIONS: Promise<void>[] = Object.freeze([]) as unknown as Promise<void>[];

type RocksTransactionWithRetry = RocksTransaction & {
	isRetry?: boolean;
	retries?: number;
	hasStagedLog?: boolean;
	stagedTxnTime?: number;
	commitStartedAt?: number;
	commitOverdueLogged?: boolean;
	lockHolds?: Set<RecordLockHandle>;
	holdBudgetSpent?: boolean;
	abortedByWrapper?: boolean;
	commitInFlight?: boolean;
	committed?: boolean;
	immediateCommit?: boolean;
};

// Crash-recovery replay sets `isRetry` before `save()`, so `hasStagedLog` is never set there.
function hasDurableLog(transaction: RocksTransaction | null | undefined, error?: { hasLog?: boolean }): boolean {
	const txn = transaction as RocksTransactionWithRetry | null | undefined;
	return error?.hasLog === true || Boolean(txn?.isRetry && txn?.hasStagedLog);
}

function releaseTransactionLockHolds(transaction: RocksTransaction | null | undefined): void {
	const txn = transaction as RocksTransactionWithRetry | null | undefined;
	const holds = txn?.lockHolds;
	if (!holds) return;
	txn.lockHolds = undefined;
	for (const handle of holds) {
		handle.releaseCommitHold?.();
	}
}

export class DatabaseTransaction implements Transaction {
	#context: Context;
	// Whether a resources/transaction.ts scope owns this instance — i.e. a final commit or abort is
	// guaranteed to follow. Only such a transaction may be rotated to a new generation by a mid-scope
	// commit (see rotateAfterMidScopeCommit); anything else must commit each later write immediately,
	// because nothing would commit staged ones. Settable only at construction, so it cannot be turned on
	// for a transaction that is already attached to a context and running.
	#scopeOwned: boolean;
	constructor(options?: { scopeOwned?: boolean }) {
		this.#scopeOwned = options?.scopeOwned === true;
	}
	writes: TransactionWrite[] = []; // the set of writes to commit if the conditions are met
	ownedWrites?: WeakSet<TransactionWrite>;
	// the last staged write per store and key, used to chain repeat writes to the same key (linkWrite)
	declare writesByKey?: Map<any, Map<unknown, TransactionWrite>>;
	completions: Promise<void>[] = []; // the set of outstanding async operations to complete
	declare private completionHandles?: (RocksTransaction | undefined)[];
	db: RootDatabaseKind;
	transaction: RocksTransactionWithRetry;
	readTxn: ReadTransaction;
	readTxnRefCount: number;
	readTxnsUsed: number;
	// Bumped each time this instance acquires a read handle, so a reference can be returned to the
	// acquisition it came from (doneReadTxn()). Not the handle's identity: lmdb-js hands back the same
	// read Txn object for a new snapshot.
	readTxnGeneration = 0;
	timeout: number;
	// Write recency, tracked separately from `timeout`: set only by addWrite, never by a read. `timeout`
	// is re-armed by reads too (on a link with no pending writes of its own, see the fast path in
	// getReadTxn), so chainStillActive can't use it to mean "this link was written recently" — a `.next`
	// link with no writes that is being read in a loop would otherwise masquerade as write activity and
	// keep a write-holding head immortal.
	declare writeTimeout: number;
	writeTick = -1;
	timeoutBudget = 0;
	// Initialized rather than `declare`d so the class shape stays monomorphic on the write path. One clock
	// read per handle is what lets the monitor age a handle without calling into the registry every tick.
	handleOpenedAt = 0;
	// save() only stages here; ImmediateTransaction overrides it to commit, which addWrite must not defer
	saveCommits = false;
	// True where save() puts the write into this transaction's native handle, which is what lets a scope
	// take over a write staged in another transaction's `writes` (Table.ts's #saveOperation).
	// LMDBTransaction's save() is a no-op — its commit applies `writes` — so there a write can only be
	// committed by the transaction that holds it.
	stagesWriteOnSave = true;
	validated = 0;
	timestamp = 0;
	retries = 0;
	declare next: DatabaseTransaction;
	// The head of this multi-store chain, set when the link is created; absent on the head itself.
	declare root?: DatabaseTransaction;
	// When this logical commit first reached the storage engine, held on the chain root so every
	// retry round and every chained store measures ONE elapsed wait (issue #2450). Deliberately not
	// the per-attempt clock trackOutstandingCommit() keeps: that one drives thread-wide load
	// shedding and must stay per-attempt, or a long uncapped source-apply retry would 503 every
	// unrelated request on the thread. Cleared when the logical commit settles, so a reused
	// transaction's next batch starts on a fresh budget.
	declare commitStartedAt?: number;
	declare commitOverdueLogged?: boolean;
	// Whether this link is why its chain root is write-supervised (see endWriteSupervision).
	declare writeSupervised?: boolean;
	declare stale: boolean;
	// Whether this read handle's base reference (readTxnsUsed starts at 1 in getReadTxn) has been
	// consumed by a commit round; iterator references are consumed only by doneReadTxn().
	declare baseReadRefConsumed?: boolean;
	// Set when a final commit/abort wanted to release the context's back-reference (see
	// releaseContext()) but outstanding read iterators were still using this transaction —
	// doneReadTxn() completes the release once the last iterator drains.
	declare pendingContextRelease?: boolean;
	declare startedFrom?: {
		resourceName: string;
		method: string;
	};
	declare stackTraces?: StartedTransaction[];
	overloadChecked: boolean;
	open = TRANSACTION_STATE.OPEN;
	replicatedConfirmation: number;
	checkedResidentPeerLists?: string[][] | null;
	checkedFor?: RocksTransaction;
	// Set when this transaction is applying data from a canonical source of truth (replication peer
	// or external caching source); its commits retry transient conflicts without the request-path
	// retry cap. Propagated to chained (multi-store) transactions in txnForContext.
	declare sourceApply?: boolean;
	// Set when this transaction replays the local audit log during crash recovery (replayLogs.ts).
	// Replayed records were valid when first written, so schema validation is skipped — a schema
	// that has since added required fields must not block replaying older records (harper#1316).
	// An explicit marker rather than overloading `retries`, which is also bumped by transient
	// conflict retries and never reset, so it cannot reliably signal "this is a replay".
	declare isReplay?: boolean;
	// Set by the long-transaction monitor when it aborts a write-bearing transaction that exceeded the
	// open-transaction limit. Once poisoned, any further addWrite/commit throws transactionOpenTooLongError
	// so the request rolls back cleanly instead of silently committing a partial write set (issue #1407).
	declare timedOut?: boolean;
	// The monitor's force-commit, which the owner's commit joins (resources/DESIGN.md). Kept after a failure
	// until a final commit reports it: the monitor only logs it.
	declare monitorCommit?: Promise<CommitResolution>;
	// Set once the retained read handle's write intents have been released (see commit()'s
	// outstanding-iterators branch), so a retry round cannot re-fire the release.
	declare writesAbandoned?: boolean;
	// Set once a mid-scope commit has rotated this instance to a new generation: every native
	// transaction it opens from then on reads WITHOUT a snapshot. Committing mid-scope is how a handler
	// asks to stop reading a pinned snapshot, so re-pinning one for the rest of the scope would take
	// back what it asked for.
	snapshotFree = false;
	// Set while commit() is parked in its pre-commit await (`before`/`beforeIntermediate` completions —
	// in practice a blob's durable file write). The write set is sealed and the caller is awaiting the
	// commit, so this is core's own I/O rather than an application holding a transaction open, which is
	// what the open-transaction limit polices: the monitor spares it for COMMIT_PHASE_GRACE ticks
	// instead of poisoning it (issue #2062).
	committing = false;
	commitPhaseTicks = 0;
	declare commitChainHead?: DatabaseTransaction;
	// O(1) lookup in recordLockFor; only lock() handles are registered here (no gate handles).
	declare recordLocks?: Map<any, Map<unknown, RecordLockHandle>>;
	/**
	 * Whether any staged write was made through a record lock handle. The commit-time lease fence
	 * below is skipped entirely when this is false, which is every transaction in a core-only
	 * deployment: without it a bulk transaction of 100,000 plain writes pays 100,000 property checks
	 * before submission, on a path that is supposed to be untouched when no lock is involved. It
	 * latches rather than tracking a count, because a write whose handle was released or expired after
	 * staging is exactly what the fence exists to catch.
	 */
	declare hasLeaseProtectedWrite?: boolean;
	// Tracks in-flight acquireRecordKey calls so concurrent lock() calls for the same key in one
	// link (e.g. Promise.all([T.lock(id), T.lock(id)])) can coalesce rather than self-block.
	declare pendingLocks?: Map<any, Map<unknown, Promise<RecordLockHandle>>>;

	setCommitPhase(committing: boolean): void {
		// A commit phase covers the sealed write set across the whole multi-store chain.
		for (let txn: DatabaseTransaction = this; txn; txn = txn.next) {
			txn.committing = committing;
			txn.commitChainHead = committing ? this : undefined;
			if (committing) txn.commitPhaseTicks = 0;
		}
	}
	// Set by abortDueToDisconnect when the request's client disconnects while this transaction is still
	// open (harper#2001). Once poisoned, any further addWrite/commit throws requestAbortedError, mirroring
	// timedOut above — the difference is only WHY the transaction was cut short.
	declare disconnected?: boolean;
	// The signal of the request this chain writes for, set on the root wherever a transaction is created
	// for a request context (resources/transaction.ts, Table.ts txnForContext). Cancellation belongs to
	// the request: once it aborts, no link admits another write, whichever transaction it arrives on.
	declare requestSignal?: AbortSignal;
	// On the root while the chain owns writes: attached at the first admitted write, released once they
	// and every commit attempt have settled, so a read-only request never registers one.
	declare requestAbortListener?: () => void;
	// Read references taken through useReadTxn() and not yet returned: the ownership record that bounds a
	// retained read snapshot. See closeOwnedReadIterators().
	declare ownedReadIterators?: Set<OwnedReadIterator>;
	// Depth of commit() attempts on this link that have not reached a native outcome.
	commitsInFlight = 0;
	declare private activeCommitHandle?: RocksTransaction;
	declare private activeCommitHandles?: Set<RocksTransaction>;
	declare private activeHandleStagedTxnTime?: number;
	declare private activeHandleInFlight?: boolean;
	declare private activeHandleCommitted?: boolean;
	// A poison landed while a commit was already in flight somewhere in the chain. Excuses the head's
	// cascade into `next`, but not a link the monitor poisoned BEFORE any commit started.
	declare poisonedMidCommit?: boolean;
	// The bound exists because a commit that never settles would otherwise make the point-of-no-return
	// warning permanent. A deadline rather than a tick count, and root-scoped: both engines' monitors
	// can visit every link of a chain, so a counter would advance once per link per tick.
	declare deferredPoisonDeadline?: number;
	declare unsubmittedCommitDeadline?: number;
	// Retry count of the chain's logged retry at the monitor's last tick, and the tick that decided whether
	// it had moved: a count that stops moving is a native attempt that never settled, and every link the
	// monitor visits in one tick must read the same decision.
	declare loggedRetriesSeen?: number;
	declare loggedRetriesChangedAt?: number;
	declare loggedRetriesTick?: number;
	declare loggedRetryAdvancing?: boolean;
	// Per-link submission state. A commit method can still be parked in pre-commit work, where an abort
	// is safe; once storage work has been submitted, its outcome is unknown and monitor cleanup must not
	// clear writes or blobs that the eventual commit can reference.
	nativeCommitSubmitted = false;
	// Root-only aggregate, retained until every attempt in the multi-store chain settles. An earlier
	// link can have submitted before a later link parks in pre-commit work, so a per-link check alone
	// cannot prove that aborting the logical transaction is safe.
	commitSubmitted = false;
	declare submittedLink?: DatabaseTransaction;
	declare submittedLinks?: Set<DatabaseTransaction>;
	// Keeps even a single-link submitted commit visible to the long-transaction monitor after its
	// native handle has been detached from the read registry.
	submittedCommitSupervised = false;
	// A stalled post-submit attempt can outlive its request, but its separate read snapshot does not
	// need to. This per-link latch makes that non-destructive cleanup once-only.
	declare stalledCommitResourcesReleased?: boolean;
	// Ordinary post-submit work is poisoned once after the diagnostic grace. The already-started chain
	// continues; genuinely fresh work is rejected. Protected source/replay work is never poisoned.
	declare postSubmitPoisoned?: boolean;
	declare stalledCommitLogged?: boolean;
	// Root-only: the owning scope ended while a commit was in flight, so the wrapper could neither abort
	// it nor close the iterators it owns. Both are finished by endCommitAttempt() when the attempt settles,
	// against the links captured here rather than the `next` chain a settling commit detaches.
	declare scopeAbandoned?: boolean;
	declare abandonedLinks?: DatabaseTransaction[];
	committingWrites = false;
	// Root-scoped history survives abort cleanup until the logical scope ends.
	declare writesRolledBack?: boolean;

	rangeReadActive = false;

	renewReadTimeout(): void {
		// The limit is an IDLE limit. Writes always re-arm it (see addWrite), but reads only do so
		// while no uncommitted writes are held: staged writes hold write intents that other writers'
		// coordinated-retry commits park on, so a handler that wrote once and then only reads — an
		// orphaned long-poll whose client had already gone, in harper#2001 — must not keep those
		// intents alive by reading. A transaction that keeps writing stays alive; so does a purely
		// read-only one. A committed transaction re-arms too: its intents went with the commit, and
		// the monitor bounds its retained read snapshot separately.
		// `writes`/`next` are checked inline first: this is a hot path and the dominant case is a
		// single-store transaction that has never written.
		if ((this.writes.length === 0 && !this.next) || this.open !== TRANSACTION_STATE.OPEN || !this.hasPendingWrites()) {
			this.timeout = Math.max(txnExpiration, this.timeoutBudget);
		}
	}

	// Each engine keeps its own expiration; LMDBTransaction overrides this with its own.
	renewIdleTimeout(): void {
		this.timeout = Math.max(txnExpiration, this.timeoutBudget ?? 0);
	}

	// The links after this one wait for its native commit before their own commit() is entered; each
	// hop starts with a full idle window and a stalled native commit is still bounded by one.
	renewChainForNativeCommit(): void {
		for (let txn: DatabaseTransaction = this; txn; txn = txn.next) {
			if (txn.timedOut || txn.open === TRANSACTION_STATE.CLOSED) continue;
			txn.renewIdleTimeout();
		}
	}

	getReadTxn(disableSnapshot?: boolean): ReadTransaction {
		this.readTxnRefCount = (this.readTxnRefCount || 0) + 1;
		this.renewReadTimeout();
		if (this.transaction) {
			if ((this.transaction as any).openTimer) (this.transaction as any).openTimer = 0;
			return this.transaction;
		}
		if (this.open !== TRANSACTION_STATE.OPEN) return; // can not start a new read transaction as there is no future commit that will take place, just have to allow the read to latest database state

		// `disableSnapshot` (requested via `snapshot: false` on a query) reads against the latest
		// committed data without pinning a consistent snapshot — so a long scan does not hold a
		// snapshot that blocks compaction. Only applied when creating the transaction fresh; an
		// already-open transaction keeps whatever snapshot mode it was created with.
		// `coordinatedRetry` signals IsBusy write conflicts as RETRY_NOW rather than ERR_BUSY.
		this.attachOwnedTransaction(
			new RocksTransaction(this.db.store, {
				coordinatedRetry: true,
				disableSnapshot: disableSnapshot || this.snapshotFree,
			})
		);
		if (disableSnapshot || this.snapshotFree) (this.transaction as any).snapshotDisabled = true;

		if (this.timestamp) {
			this.transaction.setTimestamp(this.timestamp);
		}

		if (DEBUG_LONG_TXNS) {
			this.stackTraces = [new StartedTransaction()];
		}
		if ((this.transaction as any).openTimer) (this.transaction as any).openTimer = 0;
		trackedTxns.add(this);
		if (trackedTxns.size > readTxnQueueDepthHighWater) readTxnQueueDepthHighWater = trackedTxns.size;
		return this.transaction;
	}

	// Monitor state is not ownership state: it stays with `trackedTxns.add` in getReadTxn().
	private attachOwnedTransaction(transaction: RocksTransactionWithRetry): void {
		this.transaction = transaction;
		readTransactionOwners.set(transaction, this);
		this.rangeReadActive = false;
		this.readTxnsUsed = 1;
		this.readTxnGeneration++;
		this.baseReadRefConsumed = false;
		this.handleOpenedAt = performance.now();
	}

	/**
	 * Drop this link's supervision claim, and the root's with it once no link in the chain still holds
	 * one. Membership is keyed on the root but claimed per link, so removing it on any link's detach
	 * would unsupervise a logical transaction still holding writes elsewhere in the chain.
	 */
	/**
	 * Give up on the whole chain: release any handle its links still hold, then drop the supervision
	 * that was the only remaining way to find them. Clearing the bookkeeping alone would strand a live
	 * handle in neither registry — the chained-commit throw this exists for is exactly the case where a
	 * link never reached its own detach. Snapshots only, matching the CLOSED branch that calls this:
	 * staged writes may be riding an in-flight replay commit and are not the monitor's to drop.
	 */
	dropWriteSupervision(): void {
		const root = this.root ?? this;
		for (let link: DatabaseTransaction = root; link; link = link.next) {
			if (link.transaction) link.releaseReadTxn(); // detaches, which clears this link's own claim
			link.writeSupervised = false;
		}
		supervisedWriteRoots.delete(root);
	}

	private endWriteSupervision(): void {
		if (!this.writeSupervised) return;
		this.writeSupervised = false;
		const root = this.root ?? this;
		for (let link: DatabaseTransaction = root; link; link = link.next) {
			if (link.writeSupervised) return;
		}
		if (root.submittedCommitSupervised) return;
		supervisedWriteRoots.delete(root);
	}

	private detachOwnedTransaction(): RocksTransactionWithRetry | null {
		const transaction = this.transaction;
		trackedTxns.delete(this);
		this.endWriteSupervision();
		this.transaction = null;
		this.rangeReadActive = false;
		this.readTxnsUsed = 0;
		this.readTxnRefCount = 0;
		this.handleOpenedAt = 0;
		return transaction;
	}

	/**
	 * Record that `iterator` owes a doneReadTxn(). Without the record, a retained handle's only
	 * reclamation path is an onDone() an abandoned request leaves nobody to call.
	 */
	registerReadIterator(iterator: OwnedReadIterator): void {
		// A transaction with no handle of its own (an ImmediateTransaction, which a context reuses for
		// every search it makes) has nothing to reclaim and is in no monitor's registry, so an entry here
		// would never be swept — it would just pin every partially-consumed result set on that context.
		if (!this.transaction && !this.readTxn) return;
		(this.ownedReadIterators ??= new Set()).add(iterator);
	}

	unregisterReadIterator(iterator: OwnedReadIterator): void {
		this.ownedReadIterators?.delete(iterator);
	}

	/**
	 * Close every read iterator this transaction still owns, returning how many references came back.
	 * Idempotent — each onDone() clears itself — but only safe once nothing can still be consuming them.
	 */
	closeOwnedReadIterators(): number {
		let closed = 0;
		// The whole multi-store chain: a handler that searched a second database registered that
		// iterator on the `next` link that owns its handle, not on the head.
		for (let txn: DatabaseTransaction = this; txn; txn = txn.next) {
			const iterators = txn.ownedReadIterators;
			if (!iterators?.size) continue;
			// Snapshot first: onDone() deregisters, mutating the set as we walk it.
			for (const iterator of [...iterators]) {
				iterators.delete(iterator);
				try {
					if (iterator.onDone) {
						iterator.onDone();
						closed++;
					}
				} catch (error) {
					harperLogger.warn?.('Failed to close a read iterator owned by an abandoned transaction', error);
				}
			}
		}
		return closed;
	}

	useReadTxn(disableSnapshot?: boolean) {
		const readTxn = this.getReadTxn(disableSnapshot);
		// stackTraces is seeded by the same getReadTxn branch that registers the transaction with
		// trackedTxns, so its presence means the monitor can actually dump what is pushed here. A
		// transaction that reached this point any other way — handle adopted by save(), past OPEN, or an
		// ImmediateTransaction, whose getReadTxn never returns a handle — is untracked, and pushing to
		// the array it never got threw (issue #2222). Capturing an Error per read that nothing can dump
		// is not worth doing either, so those reads stay untraced.
		if (DEBUG_LONG_TXNS && this.stackTraces) this.stackTraces.push(new StartedTransaction());
		if (readTxn) this.readTxnsUsed++;
		return readTxn;
	}

	doneReadTxn(generation = this.readTxnGeneration) {
		if (!this.transaction || generation !== this.readTxnGeneration) return;
		if (--this.readTxnsUsed === 0) {
			// The native handle was only being held open for the read iterators: any writes staged
			// through it were already committed at commit() time by replaying them onto a fresh
			// transaction (see the outstanding-iterators branch in commit()), so aborting it here
			// discards nothing — the replay re-staged the writes AND their audit/txn-log entries
			// into its own transaction; this handle's never-committed log batch dies with it.
			const transaction = this.detachOwnedTransaction();
			releaseLocalKey(transaction);
			try {
				transaction?.abort();
			} catch (error) {
				// Contained, not ignored: abort() calls this before it marks the wrapper CLOSED, clears
				// writes and releases the context. Warn rather than debug — reached from abort()'s drain
				// loop the handle can still hold write intents, and stalled writers with a clean log is
				// the worst outcome here.
				harperLogger.warn?.('Failed to release a transaction’s native handle', error);
			}
			this.completeDeferredContextRelease();
		}
	}

	private releaseRetainedWriteIntents(): void {
		if (this.writesAbandoned) return;
		this.writesAbandoned = true;
		try {
			(this.transaction as { abandonWrites?: () => void } | null)?.abandonWrites?.();
		} catch (error) {
			harperLogger.warn?.('Failed to release write intents on a retained read transaction', error);
		}
	}

	/**
	 * Force-release the retained native read handle without touching staged writes. Used by the
	 * long-transaction monitor for a CLOSED (already-acknowledged) transaction whose iterators have
	 * held the read snapshot past the open-transaction limit: the writes are not the monitor's to
	 * abort (an in-flight replay commit owns them), only the snapshot's lifetime is enforced.
	 */
	releaseReadTxn(): void {
		const transaction = this.detachOwnedTransaction();
		abortNativeTransaction(
			transaction,
			'releasing timed-out read transaction',
			this.writes[0]?.store ?? this.db,
			this.startedFrom
		);
		this.completeDeferredContextRelease();
	}

	/**
	 * Complete a context release that releaseContext() deferred because outstanding read iterators
	 * were still using this transaction (see releaseContext()) — called once the last one drains,
	 * whether that happens naturally (doneReadTxn()) or is forced by the long-transaction monitor
	 * (releaseReadTxn()).
	 */
	protected completeDeferredContextRelease(): void {
		if (!this.pendingContextRelease) return;
		this.pendingContextRelease = false;
		if (this.#context?.transaction === this) this.#context.transaction = RELEASED_TRANSACTION;
	}

	disregardReadTxn(): void {
		// Never release a handle carrying staged writes: commit() skips re-staging a write it has marked
		// saved, so aborting the handle here drops it. The count is clamped because every getReadTxn()
		// increments it but only this releases, so an unpaired call would drive it negative and cancel
		// out a later handle's references.
		if (this.readTxnRefCount > 0 && --this.readTxnRefCount === 0 && this.readTxnsUsed === 1) {
			if (this.writes.length > 0) return;
			this.doneReadTxn();
		}
	}

	/**
	 * Chain a newly staged write to the preceding write to the same store and key, so its commit
	 * handler can apply on top of what that write staged instead of the pre-transaction record
	 * (see priorStagedWrite). Called by both engines' addWrite.
	 */
	linkWrite(operation: TransactionWrite): void {
		if (operation.key === undefined) return;
		let writesForStore = (this.writesByKey ??= new Map()).get(operation.store);
		if (!writesForStore) this.writesByKey.set(operation.store, (writesForStore = new Map()));
		const keyId = (operation.keyId = writeKeyId(operation.key));
		const priorWrite = writesForStore.get(keyId);
		if (priorWrite) operation.priorWrite = priorWrite;
		writesForStore.set(keyId, operation);
	}

	/**
	 * Drop a staged write from this transaction, and from its per-key chain, so the transaction taking it
	 * over becomes its only owner (Table.ts's #saveOperation).
	 */
	detachWrite(operation: TransactionWrite): void {
		const index = this.writes.indexOf(operation);
		if (index > -1) this.writes[index] = null;
		this.ownedWrites?.delete(operation);
		if (operation.stagedIn === this) operation.stagedIn = undefined;
		if (operation.key === undefined) return;
		const writesForStore = this.writesByKey?.get(operation.store);
		if (!writesForStore) return;
		const keyId = writeKeyId(operation.key);
		// Membership, not `stagedIn`, which every commit handler clears and so cannot tell a takeover from a
		// write done in place; a prior already taken over must not become this transaction's basis again.
		let prior = operation.priorWrite;
		while (prior && !this.ownedWrites?.has(prior)) prior = prior.priorWrite;
		const tail = writesForStore.get(keyId);
		if (tail === operation) {
			if (prior) writesForStore.set(keyId, prior);
			else writesForStore.delete(keyId);
			return;
		}
		// A successor left chained to it would take its merge basis and index diff from a record another
		// transaction owns and may roll back (harper#1968's failure class).
		for (let successor = tail; successor; successor = successor.priorWrite) {
			if (successor.priorWrite === operation) {
				successor.priorWrite = prior;
				return;
			}
		}
	}

	registerRecordLock(handle: RecordLockHandle): void {
		if (!this.recordLocks) this.recordLocks = new Map();
		let storeMap = this.recordLocks.get(handle.store);
		if (!storeMap) this.recordLocks.set(handle.store, (storeMap = new Map()));
		storeMap.set(handle.keyId, handle);
	}

	recordLockFor(store: any, keyId: unknown): RecordLockHandle | undefined {
		const storeMap = this.recordLocks?.get(store);
		if (!storeMap) return undefined;
		const h = storeMap.get(keyId);
		if (!h) return undefined;
		if (!h.isExpired()) return h;
		// Prune released/expired handles so they don't accumulate; a handle past its deadline checking
		// re-entrancy would otherwise be seen as the holder and incorrectly granted access.
		storeMap.delete(keyId);
		return undefined;
	}

	unregisterRecordLock(handle: RecordLockHandle): void {
		const storeMap = this.recordLocks?.get(handle.store);
		if (storeMap?.get(handle.keyId) === handle) storeMap.delete(handle.keyId);
	}

	registerPendingLock(store: any, keyId: unknown, pending: Promise<RecordLockHandle>): void {
		if (!this.pendingLocks) this.pendingLocks = new Map();
		let storeMap = this.pendingLocks.get(store);
		if (!storeMap) this.pendingLocks.set(store, (storeMap = new Map()));
		storeMap.set(keyId, pending);
	}

	pendingLockFor(store: any, keyId: unknown): Promise<RecordLockHandle> | undefined {
		return this.pendingLocks?.get(store)?.get(keyId);
	}

	unregisterPendingLock(store: any, keyId: unknown): void {
		this.pendingLocks?.get(store)?.delete(keyId);
	}

	/** Release every transaction-scoped lock() handle this link owns. */
	releaseRecordLocks(): void {
		const recordLocks = this.recordLocks;
		if (!recordLocks) return;
		for (const [store, storeMap] of recordLocks) {
			for (const [keyId, handle] of storeMap) {
				if (handle.hold) continue; // hold handles outlive the transaction; released by unlock()
				handle.release();
				storeMap.delete(keyId);
			}
			if (storeMap.size === 0) recordLocks.delete(store);
		}
		if (recordLocks.size === 0) this.recordLocks = undefined;
	}

	private budgetCarrier(transaction?: RocksTransaction | null): {
		commitStartedAt?: number;
		commitOverdueLogged?: boolean;
	} {
		const txn = transaction as RocksTransactionWithRetry | null | undefined;
		if (txn?.commitStartedAt != null) return txn;
		if (this.saveCommits && txn && this.hasSiblingCommitInFlight(transaction ?? undefined)) {
			return txn;
		}
		if (txn?.immediateCommit) return txn;
		return this.saveCommits ? this : (this.root ?? this);
	}

	private backfillActiveHandleWrites(handle: RocksTransaction): void {
		if ((handle as RocksTransactionWithRetry).immediateCommit) return;
		for (let i = 0; i < this.writes.length; i++) {
			const w = this.writes[i];
			if (w?.saved && !w.stagedOn) w.stagedOn = handle;
		}
	}

	private isSingleHandleTarget(txn: RocksTransaction): boolean {
		return (
			!(txn as RocksTransactionWithRetry).immediateCommit &&
			(!this.activeCommitHandles || this.activeCommitHandles.size === 0) &&
			(!this.activeCommitHandle || this.activeCommitHandle === txn)
		);
	}

	private getHandleStagedTxnTime(txn?: RocksTransaction | null): number | undefined {
		if (!txn) return undefined;
		if (
			this.isSingleHandleTarget(txn) &&
			(this.activeCommitHandle === txn || (!this.activeCommitHandle && (!this.transaction || this.transaction === txn)))
		) {
			return this.activeHandleStagedTxnTime || (txn as RocksTransactionWithRetry).stagedTxnTime;
		}
		return (txn as RocksTransactionWithRetry).stagedTxnTime;
	}

	private setHandleStagedTxnTime(txn: RocksTransaction, txnTime: number): void {
		if (
			this.isSingleHandleTarget(txn) &&
			(this.activeCommitHandle === txn || (!this.activeCommitHandle && (!this.transaction || this.transaction === txn)))
		) {
			if (!this.activeHandleStagedTxnTime) this.activeHandleStagedTxnTime = txnTime;
			return;
		}
		(txn as RocksTransactionWithRetry).stagedTxnTime ??= txnTime;
	}

	private isHandleCommitInFlight(txn?: RocksTransaction | null): boolean {
		if (!txn) return false;
		if (this.activeCommitHandle === txn) {
			return Boolean(this.activeHandleInFlight || (txn as RocksTransactionWithRetry).commitInFlight);
		}
		return Boolean((txn as RocksTransactionWithRetry).commitInFlight);
	}

	private setHandleCommitInFlight(txn: RocksTransaction, inFlight: boolean): void {
		if (this.isSingleHandleTarget(txn) && inFlight && !this.activeCommitHandle) {
			this.activeCommitHandle = txn;
		}
		if (this.activeCommitHandle === txn) {
			this.activeHandleInFlight = inFlight;
			if (!inFlight) {
				(txn as RocksTransactionWithRetry).commitInFlight = false;
			}
			return;
		}
		(txn as RocksTransactionWithRetry).commitInFlight = inFlight;
	}

	private isHandleCommitted(txn?: RocksTransaction | null): boolean {
		if (!txn) return false;
		if (this.activeCommitHandle === txn) {
			return Boolean(this.activeHandleCommitted || (txn as RocksTransactionWithRetry).committed);
		}
		return Boolean((txn as RocksTransactionWithRetry).committed);
	}

	private setHandleCommitted(txn: RocksTransaction): void {
		if (this.activeCommitHandle === txn) {
			this.activeHandleInFlight = false;
			this.activeHandleCommitted = true;
			(txn as RocksTransactionWithRetry).commitInFlight = false;
			return;
		}
		(txn as RocksTransactionWithRetry).commitInFlight = false;
		(txn as RocksTransactionWithRetry).committed = true;
	}

	private trackActiveCommitHandle(transaction: RocksTransaction): void {
		if (
			!(transaction as RocksTransactionWithRetry).immediateCommit &&
			!this.activeCommitHandle &&
			(!this.activeCommitHandles || this.activeCommitHandles.size === 0)
		) {
			this.activeCommitHandle = transaction;
			return;
		}
		if (this.activeCommitHandle === transaction) return;
		let handles = this.activeCommitHandles;
		if (!handles) {
			handles = this.activeCommitHandles = new Set();
		}
		if (this.activeCommitHandle) {
			const first = this.activeCommitHandle as RocksTransactionWithRetry;
			if (this.activeHandleStagedTxnTime && !first.stagedTxnTime) {
				first.stagedTxnTime = this.activeHandleStagedTxnTime;
			}
			if (this.activeHandleInFlight) first.commitInFlight = true;
			if (this.activeHandleCommitted) first.committed = true;
			this.activeHandleStagedTxnTime = 0;
			this.activeHandleInFlight = false;
			this.activeHandleCommitted = false;
			this.backfillActiveHandleWrites(first);
			if (this.saveCommits) {
				if (this.commitStartedAt != null && first.commitStartedAt == null) {
					first.commitStartedAt = this.commitStartedAt;
					this.commitStartedAt = undefined;
				}
				if (this.commitOverdueLogged) {
					first.commitOverdueLogged = true;
					this.commitOverdueLogged = undefined;
				}
			}
			handles.add(this.activeCommitHandle);
			this.activeCommitHandle = undefined;
		}
		handles.add(transaction);
	}

	private releaseActiveCommitHandle(transaction: RocksTransaction): void {
		if (this.activeCommitHandle === transaction) {
			this.activeCommitHandle = undefined;
			this.activeHandleStagedTxnTime = 0;
			this.activeHandleInFlight = false;
			this.activeHandleCommitted = false;
			return;
		}
		const handles = this.activeCommitHandles;
		if (!handles) return;
		handles.delete(transaction);
		if (handles.size === 1) {
			for (const remaining of handles) {
				const rem = remaining as RocksTransactionWithRetry;
				if (!rem.immediateCommit) {
					this.activeCommitHandle = remaining;
					this.activeHandleStagedTxnTime = rem.stagedTxnTime ?? 0;
					this.activeHandleInFlight = Boolean(rem.commitInFlight);
					this.activeHandleCommitted = Boolean(rem.committed);
					handles.clear();
				}
			}
		}
	}

	private clearActiveCommitHandles(): void {
		if (this.activeCommitHandle !== undefined || this.activeHandleStagedTxnTime) {
			this.activeCommitHandle = undefined;
			this.activeHandleStagedTxnTime = 0;
			this.activeHandleInFlight = false;
			this.activeHandleCommitted = false;
		}
		this.activeCommitHandles?.clear();
	}

	private hasActiveCommitHandle(): boolean {
		return (
			this.activeCommitHandle !== undefined ||
			(this.activeCommitHandles !== undefined && this.activeCommitHandles.size > 0)
		);
	}

	/**
	 * Retries so far of the handles with a durable transaction-log entry still retrying their commit on
	 * this link, summed over overlapping commits so the total moves whenever any of them does, or -1
	 * when there is none.
	 */
	activeDurableLogRetries(): number {
		let retries = -1;
		const note = (handle: RocksTransaction | null | undefined) => {
			const txn = handle as RocksTransactionWithRetry | null | undefined;
			if (!txn || !hasDurableLog(txn) || this.isHandleCommitted(txn) || txn.abortedByWrapper) return;
			retries = Math.max(retries, 0) + (txn.retries ?? 0);
		};
		note(this.activeCommitHandle);
		if (this.activeCommitHandles) for (const handle of this.activeCommitHandles) note(handle);
		note(this.transaction);
		return retries;
	}

	private isActiveCommitHandle(transaction: RocksTransaction): boolean {
		return this.activeCommitHandle === transaction || Boolean(this.activeCommitHandles?.has(transaction));
	}

	private hasSiblingCommitInFlight(targetTransaction?: RocksTransaction): boolean {
		const excluded = targetTransaction ?? this.transaction;
		if (this.activeCommitHandle) return this.activeCommitHandle !== excluded;
		const active = this.activeCommitHandles;
		if (!active || active.size === 0) return false;
		if (!excluded) return true;
		return active.size > (active.has(excluded) ? 1 : 0);
	}

	private isWriteOwnedByActiveCommit(
		write: TransactionWrite | undefined,
		targetTransaction: RocksTransaction | undefined,
		hasSiblingInFlight: boolean,
		fromAbort = false,
		excludeImmediate = false
	): boolean {
		if (!write) return false;
		if ((targetTransaction as RocksTransactionWithRetry | undefined)?.immediateCommit) {
			return write.stagedOn !== targetTransaction;
		}
		if (write.deferSave && !write.saved && this.saveCommits)
			return (
				(!fromAbort || Boolean(targetTransaction) || Boolean((this as { isCommitting?: boolean }).isCommitting)) &&
				!write.stagedOn &&
				!write.lockHandle?.released &&
				!write.lockHandle?.isExpired()
			);
		if (!write.saved)
			return !fromAbort && Boolean(targetTransaction) && this.open === TRANSACTION_STATE.OPEN && !write.stagedOn;
		const stagedOn = (write.stagedOn ?? this.activeCommitHandle ?? this.transaction) as
			RocksTransactionWithRetry | undefined;
		if (!stagedOn || stagedOn === targetTransaction || stagedOn.abortedByWrapper || this.isHandleCommitted(stagedOn))
			return false;
		if (excludeImmediate && stagedOn.immediateCommit) return false;
		if (
			!fromAbort &&
			Boolean(targetTransaction) &&
			this.open === TRANSACTION_STATE.OPEN &&
			stagedOn === this.transaction
		)
			return true;
		if (
			hasSiblingInFlight &&
			(Boolean(targetTransaction) ||
				(!fromAbort && this.isActiveCommitHandle(stagedOn)) ||
				(fromAbort &&
					this.isActiveCommitHandle(stagedOn) &&
					((!excludeImmediate && Boolean(stagedOn.immediateCommit)) || Boolean(stagedOn.isRetry))))
		)
			return true;
		return Boolean(this.isHandleCommitInFlight(stagedOn) || hasDurableLog(stagedOn));
	}

	private hasWriteOwnedByActiveCommit(
		targetTransaction: RocksTransaction | undefined,
		hasSiblingInFlight: boolean,
		fromAbort = false,
		excludeImmediate = false
	): boolean {
		if (!this.stagesWriteOnSave) return false;
		for (let i = 0; i < this.writes.length; i++) {
			if (
				this.isWriteOwnedByActiveCommit(
					this.writes[i],
					targetTransaction,
					hasSiblingInFlight,
					fromAbort,
					excludeImmediate
				)
			)
				return true;
		}
		return false;
	}

	private hasSavedWrite(): boolean {
		for (let i = 0; i < this.writes.length; i++) {
			if (this.writes[i]?.saved) return true;
		}
		return false;
	}

	private hasWriteToDiscard(
		nativeTxn: RocksTransaction | null | undefined,
		targetTransaction: RocksTransaction | undefined,
		hasSiblingInFlight: boolean,
		preserveActiveWrites: boolean
	): boolean {
		for (let i = 0; i < this.writes.length; i++) {
			const write = this.writes[i];
			if (
				!write ||
				(preserveActiveWrites && this.isWriteOwnedByActiveCommit(write, targetTransaction, hasSiblingInFlight, true))
			)
				continue;
			const owner = write.stagedOn ?? this.activeCommitHandle ?? nativeTxn;
			if (!this.isHandleCommitted(owner) && !hasDurableLog(owner)) return true;
		}
		return false;
	}

	private hasSavedWriteForHandle(transaction: RocksTransaction, isImmediateCommit: boolean): boolean {
		for (let i = 0; i < this.writes.length; i++) {
			const write = this.writes[i];
			if (!write?.saved) continue;
			if (isImmediateCommit ? write.stagedOn === transaction : !write.stagedOn || write.stagedOn === transaction) {
				return true;
			}
		}
		return false;
	}

	private retainTransactionLockHolds(transaction: RocksTransaction | null | undefined): void {
		if (!transaction || !this.hasLeaseProtectedWrite) return;
		const txn = transaction as RocksTransactionWithRetry;
		if (txn.lockHolds || txn.holdBudgetSpent) return;
		const carrier = this.budgetCarrier(transaction);
		if (carrier.commitStartedAt == null) carrier.commitStartedAt = performance.now();
		const budget = this.commitConflictBudget();
		const holdDeadlineMono = Number.isFinite(budget) ? carrier.commitStartedAt + budget : undefined;
		let holds: Set<RecordLockHandle> | undefined;
		for (let i = 0; i < this.writes.length; i++) {
			const write = this.writes[i];
			if (!write?.saved || (write.stagedOn && write.stagedOn !== transaction)) continue;
			const handle = write.lockHandle;
			if (!handle?.retainForCommit || (holds && holds.has(handle))) continue;
			handle.retainForCommit(holdDeadlineMono);
			(holds ??= new Set()).add(handle);
		}
		if (holds) txn.lockHolds = holds;
	}

	private noteCommittedLockVersions(committedTransaction?: RocksTransaction): void {
		const recordLocks = this.recordLocks;
		if (!recordLocks) return;
		const isImmediateCommit = Boolean((committedTransaction as RocksTransactionWithRetry | undefined)?.immediateCommit);
		const filterByStagedOn = Boolean(committedTransaction || this.hasSiblingCommitInFlight(committedTransaction));
		for (const write of this.writes) {
			if (!write?.saved) continue;
			if (
				isImmediateCommit
					? write.stagedOn !== committedTransaction
					: filterByStagedOn && write.stagedOn && write.stagedOn !== committedTransaction
			)
				continue;
			if (write.appliedRecordVersion == null) continue;
			const handle = write.lockHandle ?? recordLocks.get(write.store)?.get(writeKeyId(write.key));
			if (handle && !handle.released) handle.noteHolderVersion(write.appliedRecordVersion);
		}
	}

	/**
	 * Discard the staged write set (committed or aborted); the per-key chain must go with it so a
	 * reused transaction never bases a write on a previous batch's staged state. When concurrent
	 * commits share one DatabaseTransaction, only the writes staged on `committedTransaction` are
	 * removed while another native commit is still in flight.
	 */
	clearWrites(committedTransaction?: RocksTransaction, fromAbort = false): void {
		if (committedTransaction) this.releaseActiveCommitHandle(committedTransaction);
		const isImmediateCommit = Boolean((committedTransaction as RocksTransactionWithRetry | undefined)?.immediateCommit);
		const hasSiblingInFlight = this.hasSiblingCommitInFlight(committedTransaction);
		if (
			this.stagesWriteOnSave &&
			(isImmediateCommit ||
				((hasSiblingInFlight || !committedTransaction || this.commitsInFlight > 1 || this.saveCommits) &&
					this.hasWriteOwnedByActiveCommit(committedTransaction, hasSiblingInFlight, fromAbort)))
		) {
			for (const write of [...this.writes]) {
				if (!write || this.isWriteOwnedByActiveCommit(write, committedTransaction, hasSiblingInFlight, fromAbort))
					continue;
				this.detachWrite(write);
			}
			this.writes = this.writes.filter((write) => write);
			this.validated = this.writes.reduce((acc, w, idx) => (w?.saved ? idx + 1 : acc), 0);
			if (this.hasLeaseProtectedWrite && !this.writes.some((write) => write?.lockHandle)) {
				this.hasLeaseProtectedWrite = false;
			}
			return;
		}
		this.clearActiveCommitHandles();
		// A deferred write's `stagedIn` must not outlive this transaction's ability to commit it: save() can
		// fire after a commit or abort, and routing it back here would revive a write this transaction
		// already rolled back — whose blobs abort() has reclaimed. Cleared here, save() resolves the
		// context's current transaction as it did before `stagedIn` existed.
		for (const write of this.writes) {
			if (write?.stagedIn === this) write.stagedIn = undefined;
			if (write) this.ownedWrites?.delete(write);
		}
		this.writes = [];
		this.validated = 0;
		this.writesByKey = undefined;
		// The commit-fence latch belongs to the discarded batch. A reused transaction that once staged
		// a locked write would otherwise re-scan every write of every later unlocked batch. Assigned
		// only when it was set, so an ordinary transaction never gains the property at all.
		if (this.hasLeaseProtectedWrite) this.hasLeaseProtectedWrite = false;
	}

	/**
	 * Drop this transaction's back-reference from its context once completed (commit or abort),
	 * so a long-lived context (e.g. an MQTT subscription context held open for the life of a
	 * suspended delivery loop) doesn't keep pinning a finished transaction in memory. Guarded by
	 * identity: a context already re-pointed at a different (e.g. reused) transaction is untouched.
	 *
	 * `final` must be false for an in-callback explicit `context.transaction.commit()` — the
	 * "commit in the middle" pattern intentionally keeps recommitting and adding writes to the
	 * SAME instance (see the comment above about a transaction being "reused and committed
	 * again"), so releasing here would strand those later writes with no transaction to join.
	 * Only resources/transaction.ts's own wrapper commit (`{ doneWriting: true }`, once the
	 * caller's callback has fully returned) and abort() are truly final.
	 *
	 * A final commit can still have outstanding read iterators streaming through this.transaction
	 * (see the outstanding-iterators branch in commit()) — those keep this instance meaningfully
	 * alive (a fresh write on the same context must not join a DIFFERENT, already-replayed
	 * transaction) until doneReadTxn() drains the last one, so the release is deferred to there.
	 *
	 * Leaves RELEASED_TRANSACTION in the slot: the slot must stay callable (see that constant), and it
	 * must stay a plain assignment — `delete` repeatedly forces a long-lived, hot context into V8's
	 * dictionary-mode property storage.
	 */
	protected releaseContext(final: boolean): void {
		if (!final) return;
		if (this.readTxnsUsed > 0) {
			this.pendingContextRelease = true;
			return;
		}
		if (this.#context?.transaction === this) this.#context.transaction = RELEASED_TRANSACTION;
	}

	checkOverloaded() {
		if (
			oldestOutstandingCommit &&
			!this.overloadChecked &&
			performance.now() - oldestOutstandingCommit.start > MAX_OUTSTANDING_TXN_DURATION
		) {
			const now = performance.now();
			// Also rate-limited across the whole overload episode (not just deduped per commit): under
			// sustained heavy load, many distinct commits can each individually age past the limit in
			// quick succession as earlier ones finally settle, which without this cap would turn one
			// overload episode into a growing stream of ERROR lines — the same "flood" harper#2001's
			// original per-request log was fixed to avoid, just shifted from per-request to per-commit.
			// A commit skipped by the cooldown is NOT marked `logged`, so it still gets a log later if
			// it's still the oldest once the cooldown clears, rather than going silent forever.
			if (!oldestOutstandingCommit.logged && allowStuckCommitLog('shed', now)) {
				// Log once per stuck commit (not once per rejected request, harper#2001): a wedged
				// thread otherwise logs nothing at all server-side while rejecting every write with a
				// 503, which was the single biggest obstacle to root-causing a recurrence. The flag lives
				// on the node itself, so if THIS commit settles while still over the limit and a
				// different one is now oldest, that one logs too instead of staying silent forever.
				oldestOutstandingCommit.logged = true;
				harperLogger.error(
					`Rejecting writes on this thread: a commit has been outstanding for ` +
						`${Math.round(now - oldestOutstandingCommit.start)}ms (exceeds the ` +
						`${MAX_OUTSTANDING_TXN_DURATION}ms limit), ` +
						describeCommitIdentity(
							oldestOutstandingCommit.store,
							oldestOutstandingCommit.startedFrom,
							oldestOutstandingCommit.nativeTransaction,
							oldestOutstandingCommit.rootStore
						) +
						`.` +
						describeHolderCandidates(
							oldestOutstandingCommit.rootStore?.path,
							oldestOutstandingCommit.nativeTransaction?.id
						) +
						` Further record updates and publishes from new application requests on this thread ` +
						`will be rejected with 503 until the commit settles or the process is restarted (deletes, ` +
						`and writes applied from a canonical source, e.g. replication or a caching source, bypass this check).`
				);
			}
			if (now - lastOverloadStatusAt > 15_000) {
				lastOverloadStatusAt = now;
				harperLogger.status({ problem: 'database.write-queue-overloaded', expires: 60 });
			}
			throw new ServerError('Outstanding write transactions have too long a queue, please try again later', 503);
		}
		this.overloadChecked = true; // only check this once, don't interrupt ongoing transactions that have already made writes
	}

	/**
	 * What a `replicatedConfirmation` commit waits for: the log position peers must acknowledge (the
	 * committed transaction's own log key when a confirmable write appended an audit entry to it,
	 * else the last confirmable write's entry version as in lastConfirmableEntry), and the residents of its
	 * writes, as checked before submission.
	 */
	confirmationTarget(
		committedLogKey?: number,
		committedTransaction?: RocksTransaction
	): { version: number; residentPeerLists?: string[][] } | undefined {
		const residentPeerLists =
			this.checkedResidentPeerLists === undefined || this.checkedFor !== committedTransaction
				? this.residentPeerLists(committedTransaction)
				: (this.checkedResidentPeerLists ?? undefined);
		this.checkedResidentPeerLists = undefined;
		// writes that lost to newer entries appended nothing at the key, which peers would then pass only
		// when some later write replicates
		let version = this.writes.some(
			(write) => write?.saved && !write.skipReplicationConfirmation && write.appendedTo === committedTransaction
		)
			? committedLogKey
			: undefined;
		for (let i = this.writes.length - 1; i >= 0 && version === undefined; i--) {
			const write = this.writes[i];
			if (!write?.saved || write.skipReplicationConfirmation) continue;
			version = write.store.getEntry(write.key)?.version;
		}
		if (version === undefined) return;
		return { version, residentPeerLists };
	}

	/**
	 * One list of other residents per distinct residency among the confirmable writes, in no meaningful
	 * order, refusing a count any one list cannot meet (harper-pro#1031). A write placed by no residency
	 * adds no list: N confirmations from any list already come from N distinct peers.
	 */
	residentPeerLists(submitted?: RocksTransaction): string[][] | undefined {
		let lists: Map<number, string[]> | undefined;
		for (const write of this.writes) {
			if (!write?.saved || !write.residencyId || write.skipReplicationConfirmation || lists?.has(write.residencyId))
				continue;
			// a residency recorded in a round whose batch an iterator replay discarded names no append
			if (submitted && write.appendedTo !== submitted) continue;
			(lists ??= new Map()).set(
				write.residencyId,
				confirmingResidents(write.store, write.residencyId, this.replicatedConfirmation, write.key)
			);
		}
		return lists && Array.from(lists.values());
	}

	/**
	 * Refuse, before `transaction` is submitted, a confirmation this commit could never get, aborting it.
	 * Confirmation requested after a write was saved skipped that write's own refusal, so the lists are
	 * checked again here, and kept for the waiter.
	 */
	refuseUnconfirmable(transaction: RocksTransaction): void {
		// a retry of a submitted attempt (the same handle) must reach its native outcome
		if ((transaction as RocksTransactionWithRetry).isRetry) return;
		this.checkedResidentPeerLists = undefined;
		this.checkedFor = transaction;
		if (
			!this.replicatedConfirmation ||
			!this.writes.some((write) => write?.saved && !write.skipReplicationConfirmation)
		)
			return;
		try {
			const residentPeerLists = this.residentPeerLists(transaction);
			const databaseName = this.writes.find((write) => write)?.store.rootStore.databaseName;
			if (databaseName) {
				const result: any = confirmationFeasibility?.(databaseName, this.replicatedConfirmation, residentPeerLists);
				if (result?.then) {
					result.then(null, () => {});
					throw new TypeError('A replication confirmation feasibility check must be synchronous');
				}
			}
			this.checkedResidentPeerLists = residentPeerLists ?? null;
		} catch (error) {
			abortNativeTransaction(
				transaction,
				'aborting a transaction whose confirmation was refused',
				this.writes[0]?.store ?? this.db,
				this.startedFrom
			);
			try {
				this.abort(false, true, transaction);
			} catch (abortError) {
				harperLogger.debug?.('cleaning up a transaction whose confirmation was refused', abortError);
			}
			throw error;
		}
	}

	/**
	 * The stored entry of the last write eligible for replication confirmation. Two kinds of write are
	 * skipped (rather than ending the search) so a trailing one cannot suppress confirmation for
	 * replicable writes staged earlier: writes that explicitly opt out (audit-only markers, which stage
	 * no record), and writes with no stored entry at all — a delete leaves a readable tombstone on any
	 * audited or delete-tracking table, so only a delete on a table with neither is entry-less. Such a
	 * `put(A); delete(B)` confirms on A's entry, whose version is this transaction's (every write in a
	 * transaction is stamped with one version).
	 */
	lastConfirmableEntry(): Partial<Entry> | undefined {
		for (let i = this.writes.length - 1; i >= 0; i--) {
			const write = this.writes[i];
			if (!write || write.skipReplicationConfirmation) continue;
			const entry = write.store.getEntry(write.key);
			if (entry) return entry;
		}
	}

	/**
	 * Stage an async operation that commit() must wait for. Staging can happen a turn or more before
	 * commit() attaches its Promise.all, so the no-op rejection handler is attached here: without it a
	 * rejection in that window is an unhandled rejection (fatal under --unhandled-rejections=strict).
	 * The rejection still surfaces through commit()'s Promise.all.
	 */
	stageCompletion(completion: Promise<void>, transaction?: RocksTransaction) {
		completion.then(undefined, () => {});
		const index = this.completions.length;
		this.completions.push(completion);
		if (
			transaction &&
			(this.saveCommits ||
				Boolean((transaction as RocksTransactionWithRetry).immediateCommit) ||
				this.hasActiveCommitHandle() ||
				Boolean(this.completionHandles))
		) {
			(this.completionHandles ??= [])[index] = transaction;
		}
	}

	private takeCompletions(transaction?: RocksTransaction): Promise<void>[] {
		if (this.completions.length === 0) return NO_COMPLETIONS;
		const handles = this.completionHandles;
		const isImmediate = Boolean((transaction as RocksTransactionWithRetry | undefined)?.immediateCommit);
		if (!handles) {
			if (isImmediate) return NO_COMPLETIONS;
			const completions = this.completions;
			this.completions = [];
			return completions;
		}
		let allMatch = true;
		for (let i = 0; i < this.completions.length; i++) {
			const handle = handles[i];
			if (!(handle ? handle === transaction : !isImmediate)) {
				allMatch = false;
				break;
			}
		}
		if (allMatch) {
			const completions = this.completions;
			this.completions = [];
			this.completionHandles = undefined;
			return completions;
		}
		const taken: Promise<void>[] = [];
		const remaining: Promise<void>[] = [];
		const remainingHandles: (RocksTransaction | undefined)[] = [];
		for (let i = 0; i < this.completions.length; i++) {
			const completion = this.completions[i];
			const handle = handles[i];
			if (handle ? handle === transaction : !isImmediate) {
				taken.push(completion);
			} else {
				remaining.push(completion);
				remainingHandles.push(handle);
			}
		}
		this.completions = remaining;
		this.completionHandles = remainingHandles.length > 0 ? remainingHandles : undefined;
		return taken;
	}

	/**
	 * Discard staged completions that no commit() will ever aggregate (abort path). Their rejections
	 * are already no-op-handled by stageCompletion(), so without this they fail silently; log instead.
	 * Clearing them also keeps a reused transaction's next commit() from rejecting with the previous
	 * batch's error.
	 */
	drainCompletions(targetTransaction?: RocksTransaction, preserveActiveWrites = false): void {
		if (this.completions.length === 0) return;
		const handles = this.completionHandles;
		const isImmediateTarget = Boolean((targetTransaction as RocksTransactionWithRetry | undefined)?.immediateCommit);
		let drained: Promise<void>[];
		if (!preserveActiveWrites) {
			drained = this.completions;
			this.completions = [];
			this.completionHandles = undefined;
		} else {
			drained = [];
			const remaining: Promise<void>[] = [];
			const remainingHandles: (RocksTransaction | undefined)[] = [];
			for (let i = 0; i < this.completions.length; i++) {
				const completion = this.completions[i];
				const handle = handles?.[i];
				const keep = isImmediateTarget
					? handle !== targetTransaction
					: Boolean(handle) &&
						handle !== targetTransaction &&
						(this.isActiveCommitHandle(handle) || hasDurableLog(handle));
				if (keep) {
					remaining.push(completion);
					remainingHandles.push(handle);
				} else {
					drained.push(completion);
				}
			}
			this.completions = remaining;
			this.completionHandles = remainingHandles.length > 0 ? remainingHandles : undefined;
		}
		for (const completion of drained)
			completion.then(undefined, (error) =>
				harperLogger.warn?.('A staged transaction completion failed after the transaction was aborted', error)
			);
	}

	addWrite(operation: TransactionWrite) {
		if (this.timedOut || this.postSubmitPoisoned) throw transactionOpenTooLongError();
		if (this.disconnected) throw requestAbortedError();
		this.admitRequestWrite();
		// A write is activity: it re-arms the idle limit on this link even though the reads it
		// performs no longer do (see getReadTxn), so a transaction that keeps writing stays alive
		// and only an idle one holding write intents is reaped.
		this.timeout = Math.max(txnExpiration, this.timeoutBudget ?? 0);
		// Independent write-recency signal for chainStillActive (see the field comment) — reads never
		// touch this, only writes do.
		this.writeTimeout = this.timeout;
		this.writeTick = monitorTick;
		this.linkWrite(operation);
		this.writes.push(operation);
		(this.ownedWrites ??= new WeakSet()).add(operation);
		operation.stagedIn = this;
		// Hold this write back while any earlier same-key write has not run — out of staging order both
		// diff against the pre-transaction record (harper#2211, DESIGN.md). The whole chain, not just the
		// immediate link: an eager non-chaining write in between would otherwise launder the deferral.
		// Never where save() is itself the commit trigger (closed, or ImmediateTransaction): nothing would
		// run the deferred write.
		let awaitsPriorWrite = false;
		if (operation.chainsStagedState === true && this.open === TRANSACTION_STATE.OPEN && !this.saveCommits) {
			let pending = operation.priorWrite;
			while (pending?.saved)
				pending = pending.pendingPriorWrite !== undefined ? pending.pendingPriorWrite : pending.priorWrite;
			operation.pendingPriorWrite = pending ?? null;
			awaitsPriorWrite = pending != null;
		}
		if (!operation.deferSave && !awaitsPriorWrite) {
			// Setting saved to false means to defer saving
			const saveResult: any = this.save(operation);
			if (saveResult?.then) {
				// When the transaction is already committed (immediateCommit path), save() returns
				// the commit promise. Propagate it so callers can await the actual write being
				// committed rather than resolving before it is durable.
				return saveResult.then(() => operation);
			}
		}
		return operation;
	}

	save(operation: TransactionWrite, transaction?: RocksTransaction, reloadEntry = false, options?: CommitOptions) {
		if (!transaction && !options) {
			if (this.timedOut || this.postSubmitPoisoned) throw transactionOpenTooLongError();
			if (this.disconnected) throw requestAbortedError();
			// A deferred save is staged by addWrite() but admitted again when it is finally saved.
			this.admitRequestWrite();
		}
		if (!transaction && this.open !== TRANSACTION_STATE.OPEN) {
			if (this.timedOut || this.postSubmitPoisoned) throw transactionOpenTooLongError();
			if (this.disconnected) throw requestAbortedError();
		}
		const lockHandle = operation.lockHandle;
		// Guard: a write staged through an expired or released lock handle must not land.
		// The handle's lease timer already unlocked the native key; another holder may have taken it.
		// isExpired() re-evaluates the deadline here rather than trusting the timer to have run: a
		// holder whose event loop stalled past its lease would otherwise commit in the window between
		// the deadline and its own timer callback, after peers had already granted the key onward.
		//
		// A RE-save is judged by the lease alone. `released` belongs to the first stage — a caller that
		// unlocked and then saved is writing through a handle it gave back — but an operation already
		// staged was staged while the lock was held, and an `unlock()` inside the lease leaves it valid
		// (the same rule the pre-submit fence applies below). Without the distinction,
		// `lock(); save(); unlock(); commit()` succeeded normally and threw 409 only when a conflict
		// retry or an open read iterator forced the replay to re-save it.
		if (operation.saved ? lockHandle?.isLeaseExpired() && !hasDurableLog(transaction) : lockHandle?.isExpired()) {
			// Through `detachWrite`, which also repairs the per-key chain: dropping it from `writes` alone
			// leaves `writesByKey` pointing at a write that was refused, so a caller that catches this 409
			// and stages the same key again would take the rejected operation as its merge basis.
			this.detachWrite(operation);
			throw lockNotHeldError(lockHandle);
		}
		// Lock-write timestamp rules.
		if (lockHandle) {
			this.hasLeaseProtectedWrite = true;
			if (this.open === TRANSACTION_STATE.CLOSED || this.saveCommits) {
				// CLOSED path (second+ write per ImmediateTransaction cycle) OR the first write in
				// an ImmediateTransaction (open=OPEN until commit sets it CLOSED, but saveCommits
				// signals the per-write-commit semantics):  stamp with nextHolderVersion() so that
				// each sequential save() gets its own monotonically increasing stamp — scoped or hold.
				// The stamp stays on the operation and is consumed below rather than assigned to
				// this.timestamp: pinning the link's clock would stamp every OTHER write staged on
				// the same context before the commit resets it — a concurrent write in the caller's
				// own Promise.all, or the next operation in a retry/replay save loop — with the
				// lock's version, which LWW then silently drops against a newer record version.
				if (!operation.lockStamp) operation.lockStamp = lockHandle.holderVersionCandidate();
			}
		}
		const concurrentClosedWrite =
			Boolean((transaction as RocksTransactionWithRetry | undefined)?.immediateCommit) ||
			(!transaction && this.open !== TRANSACTION_STATE.OPEN && !this.saveCommits);
		let txnTime =
			operation.lockStamp ?? this.getHandleStagedTxnTime(transaction) ?? (concurrentClosedWrite ? 0 : this.timestamp);
		const mintedTimestamp = !txnTime;
		const remoteOrigin = writesRemoteOrigin(operation);
		// Only an OPEN transaction accepts new staged writes. After commit, this.transaction may still
		// be retained for outstanding read iterators; staging into it would silently discard the write
		// when doneReadTxn() aborts the handle, so such writes commit immediately on a fresh
		// transaction below instead.
		if (!transaction && this.open === TRANSACTION_STATE.OPEN) transaction = this.transaction;
		let immediateCommit = false;
		if (!transaction) {
			transaction = new RocksTransaction(
				operation.store.store as RocksStore,
				this.snapshotFree ? SNAPSHOT_FREE : undefined
			);
			if (operation.store.rootStore !== this.db.rootStore) {
				harperLogger.warn?.('Created new transaction in save, but the store does match existing store', transaction.id);
			}
			if (this.open === TRANSACTION_STATE.OPEN) {
				this.attachOwnedTransaction(transaction);
				// A write that never read is otherwise invisible to the long-transaction monitor: its
				// handle was adopted here rather than in getReadTxn(), which is the only other place that
				// registers. Supervise the chain root, so the monitor reaps the logical transaction as one
				// unit. Replay is excluded deliberately — it is synchronous, already bounded by its own
				// stall and wall-clock guards, and commits at timestamp boundaries that a monitor-driven
				// commit could split.
				if (!this.isReplay) {
					const root = this.root ?? this;
					root.timeout = Math.max(root.timeout || 0, this.timeout || txnExpiration, root.timeoutBudget || 0);
					this.writeSupervised = true;
					supervisedWriteRoots.add(root);
				}
			} else {
				// if it is closed, we have to immediately commit, using our immediate transaction
				immediateCommit = true;
				if (!this.saveCommits) (transaction as RocksTransactionWithRetry).immediateCommit = true;
			}
			if (txnTime && (this.isReplay || remoteOrigin)) transaction.setTimestamp(txnTime);
		}
		if (this.activeCommitHandle && this.activeCommitHandle !== transaction) {
			this.backfillActiveHandleWrites(this.activeCommitHandle);
		} else if (!this.activeCommitHandle && this.transaction && this.transaction !== transaction) {
			this.backfillActiveHandleWrites(this.transaction);
		}
		const shouldStampStagedOn =
			this.saveCommits ||
			immediateCommit ||
			Boolean((transaction as RocksTransactionWithRetry | undefined)?.immediateCommit) ||
			operation.stagedOn !== undefined ||
			(this.activeCommitHandles !== undefined && this.activeCommitHandles.size > 0) ||
			(this.activeCommitHandle !== undefined && this.activeCommitHandle !== transaction) ||
			(this.transaction != null && this.transaction !== transaction);
		if (this.isReplay) {
			// Replayed writes came FROM the transaction log; never re-append them —
			// replay iterates that same log, so re-appending prevents convergence
			// (boot hangs replaying its own output). Conflict retries stamp isRetry
			// at the retry sites in commit(); this is the replay-path equivalent.
			(transaction as RocksTransactionWithRetry).isRetry = true;
			(transaction as RocksTransactionWithRetry).retries = this.retries;
		} else if (!remoteOrigin) {
			// Before the first staged write, which freezes the native timestamp. A key below the floor's
			// admission bound is replaced on the handle only: `txnTime` keeps an explicit value as the
			// record version, and the entry then carries both clocks as an applied write does.
			const key = reserveLocalKey(operation.store.rootStore, transaction, txnTime || undefined);
			if (!txnTime) {
				txnTime = key;
				if (!concurrentClosedWrite) this.timestamp = key;
			}
		}
		if (!txnTime) {
			txnTime = transaction.getTimestamp();
			if (!concurrentClosedWrite) this.timestamp = txnTime;
		}
		if (!operation.lockStamp) this.setHandleStagedTxnTime(transaction, txnTime);
		if (this.saveCommits && mintedTimestamp) this.timestamp = 0;
		if (!operation.saved && operation.pendingPriorWrite) {
			const pendingWrites = [];
			for (let pending = operation.pendingPriorWrite; pending;) {
				if (!pending.saved && this.ownedWrites?.has(pending)) pendingWrites.push(pending);
				pending = pending.pendingPriorWrite !== undefined ? pending.pendingPriorWrite : pending.priorWrite;
			}
			for (let index = pendingWrites.length - 1; index >= 0; index--)
				this.save(pendingWrites[index], transaction, false, options);
			operation.pendingPriorWrite = null;
		}
		// `txnTime` is this transaction's timestamp — the key its entries take in the per-origin log.
		// A write applied from elsewhere carries the origin's record version too, and that is what the
		// record is stored at; the two coincide for every locally-originated write. Gated on the apply
		// flags so an ordinary write never reads the property (harper#2412).
		const writeVersion =
			this.sourceApply || this.isReplay ? getAppliedWriteVersion(operation.recordVersion, txnTime) : txnTime;
		// A base that feeds stored state must come from this transaction's snapshot, never the
		// cross-worker cache vouch (stale when a resequenced write reused a version). That closes the
		// lost-update window only when this transaction holds a snapshot to validate the later Put
		// against; a snapshot-free transaction (this.snapshotFree, after a mid-scope-commit rotation)
		// has no snapshot for rocksdb-js to validate the Put against, so it only narrows the window to
		// the read-to-put span rather than closing it (open follow-up, tracked in the PR description).
		// Replay bypasses the cache: WeakRef targets survive the entire synchronous job, even after eviction.
		const reloadsCommitBase = operation.reloadCommitBase && !operation.saved && !this.isReplay;
		// An entry read uncached through this same pinned-snapshot handle is already that base, until a retry resets
		// the snapshot or an earlier staged write to the key changes what a read returns; the resource withholds the
		// handle once its entry was replaced or evicted, and locked, snapshot-free and replayed writes always reload.
		const txnRetries = (transaction as RocksTransactionWithRetry | undefined)?.retries ?? 0;
		const reusesBaseRead =
			operation.baseReadTxn === transaction &&
			txnRetries === 0 &&
			!reloadEntry &&
			!operation.priorWrite &&
			!operation.lockHandle &&
			!this.snapshotFree &&
			!(transaction as any).snapshotDisabled &&
			!this.isReplay;
		const wasSaved = Boolean(operation.saved);
		let completion: Promise<void>;
		try {
			if (!reusesBaseRead && (reloadEntry || operation.entry === undefined || reloadsCommitBase)) {
				const uncachedRead = !!operation.reloadCommitBase || reloadEntry || this.isReplay;
				operation.entry = operation.store.getEntry(operation.key, { transaction, uncachedRead });
			}
			if (!operation.saved) {
				// immediately execute in this transaction
				const validated = validateWrite(operation, writeVersion, this);
				if ((validated as any) === false) {
					operation.saved = true;
					if (shouldStampStagedOn) operation.stagedOn = transaction;
					operation.commit = () => {}; // noop if we try again
					closeWriteInstance(operation);
					if (immediateCommit) {
						this.detachWrite(operation);
						if (!this.activeCommitHandle) this.activeHandleStagedTxnTime = 0;
						abortNativeTransaction(
							transaction,
							'aborting an immediate transaction with nothing to write',
							operation.store,
							this.startedFrom
						);
					}
					return;
				}
				operation.saved = true;
				let result: Promise<void> = operation.before?.() as Promise<void>;
				if (result?.then) this.stageCompletion(result, transaction);
				result = operation.beforeIntermediate?.() as Promise<void>;
				if (result?.then) this.stageCompletion(result, transaction);
			}
			if (shouldStampStagedOn) operation.stagedOn = transaction;
			if (lockHandle || this.recordLocks) operation.trackRecordVersion = true;
			if (operation.trackRecordVersion) operation.recordVersionApplied = false;
			try {
				completion = operation.commit(
					writeVersion,
					operation.entry,
					(wasSaved || this.isReplay) && txnRetries > 0,
					transaction,
					this
				) as Promise<void>;
			} finally {
				closeWriteInstance(operation);
			}
		} catch (error) {
			// A handle created for an immediate commit is owned by nobody else: a throw before its commit
			// is submitted must release it, and the floor reservation it carries, rather than leak both.
			if (immediateCommit) {
				this.drainCompletions(transaction, true);
				this.detachWrite(operation);
				if (!this.activeCommitHandle) this.activeHandleStagedTxnTime = 0;
				abortNativeTransaction(
					transaction,
					'aborting an immediate transaction whose write threw',
					operation.store,
					this.startedFrom
				);
			}
			throw error;
		}
		if (operation.trackRecordVersion)
			operation.appliedRecordVersion = operation.recordVersionApplied ? writeVersion : undefined;
		if (typeof completion?.then === 'function') this.stageCompletion(completion, transaction);
		// Sticky record that THIS write staged with its audit entry appended (log entries batch on the
		// native transaction and are durably written by its commit attempt — even a failed one — so
		// they survive the abort-after-failed-commit of the retry paths). isRetry stagings
		// skip the log write, so they never set it. The retry dedup guards in the commit handler key
		// off this: a launderable proxy (like last attempt's skipped state) breaks under multi-round
		// retries where a recommit round self-skips before a fresh-transaction replay.
		if (!operation.skipped && !(transaction as RocksTransactionWithRetry).isRetry) {
			operation.appendedAuditEntry = true;
			// unlike the sticky flag, names the handle (an iterator replay discards the original's batch);
			// recorded whether or not confirmation is requested yet, since it can be requested later
			operation.appendedTo = transaction;
		}
		if (immediateCommit) {
			// immediately commit if the harper transaction is closed
			const innerCommit = this.commit({ ...options, transaction });
			// Expose on the operation so the lock-writable Table.save() path can await the real
			// native commit — without this the ImmediateTransaction outer commit resolves before
			// the native transaction.commit() settles (fire-and-forget from the if-branch).
			operation.innerCommit = innerCommit;
			return innerCommit;
		}
	}

	/**
	 * Whether any link of this multi-store chain has a commit attempt that has not reached a native
	 * outcome. Asked of the whole chain, not just this link: the head commits its own writes and then
	 * cascades into `next`, so that cascade is a continuation of one logical commit, not a fresh one.
	 * Walked from here as well when a settling commit has already detached this link from that chain.
	 */
	isChainCommitting(): boolean {
		let attached = false;
		const root = this.root ?? this;
		for (let txn: DatabaseTransaction = root; txn; txn = txn.next) {
			if (txn.commitsInFlight) return true;
			if (txn === this) attached = true;
		}
		if (submittedCommitStillInFlight(root)) return true;
		if (attached) return false;
		// Only a link a settling commit already detached needs its own walk, and its own attempt is
		// exactly the one that must not be torn out from under it. The ordinary case — asked of the root,
		// or of a link still on the chain — is answered by the single walk above.
		for (let txn: DatabaseTransaction = this; txn; txn = txn.next) {
			if (txn.commitsInFlight) return true;
		}
		return false;
	}

	/**
	 * A submitted native write is this transaction's point of no destructive return. Only a FRESH
	 * attempt — none already in flight, and no `options.transaction` from an immediate-commit re-entry —
	 * is rejected by the poison flags. Everything that continues an already-submitted attempt (a
	 * RETRY_NOW/ERR_BUSY/ERR_TRY_AGAIN recursion, the extra-writes recursion inside performCommit) must
	 * reach its native outcome instead of abandoning unknown state; a poison that lands before submission
	 * can still abort safely (see abortAndPoison).
	 *
	 * Resolves with information on the timestamp and success of the commit.
	 */
	commit(options: CommitOptions = {}): MaybePromise<CommitResolution> {
		if (this.monitorCommit && !options.transaction) {
			return this.monitorCommit.then(
				() => this.commit(options),
				(error) => {
					// The failed commit ran its terminal cleanup, but as a non-final commit it kept the context.
					if (options.doneWriting) {
						this.monitorCommit = undefined;
						this.releaseContext(true);
					}
					throw error;
				}
			);
		}
		if (!(options.transaction && this.commitsInFlight) && !(options.continuation && this.poisonedMidCommit)) {
			if (this.timedOut || this.postSubmitPoisoned) throw transactionOpenTooLongError();
			if (this.disconnected) throw requestAbortedError();
		}
		this.commitsInFlight = (this.commitsInFlight ?? 0) + 1;
		// Only a top-level attempt records the intent: a continuation would re-read hasPendingWrites()
		// after clearWrites() has already emptied it.
		if (this.commitsInFlight === 1 && !options.continuation && this.hasPendingWrites()) {
			(this.root ?? this).committingWrites = true;
		}
		let resolution: MaybePromise<CommitResolution>;
		try {
			resolution = this.performCommit(options);
		} catch (error) {
			this.endCommitAttempt();
			throw error;
		}
		if (!(resolution as Promise<CommitResolution>)?.then) {
			this.endCommitAttempt();
			return resolution;
		}
		return (resolution as Promise<CommitResolution>).then(
			(settled) => {
				this.endCommitAttempt();
				return settled;
			},
			(error) => {
				this.endCommitAttempt();
				throw error;
			}
		);
	}

	protected markNativeCommitSubmitted(): void {
		this.nativeCommitSubmitted = true;
		const root = this.root ?? this;
		root.commitSubmitted = true;
		if (!root.submittedLink) root.submittedLink = this;
		else if (root.submittedLink !== this) (root.submittedLinks ??= new Set()).add(this);
		// LMDB has its own monitor registry and overrides this method to enroll there. Do not put an
		// LMDB link into the RocksDB monitor as well (stagesWriteOnSave is the engine discriminator).
		if (this.stagesWriteOnSave) {
			root.submittedCommitSupervised = true;
			supervisedWriteRoots.add(root);
		}
	}

	/** Engine hook for a submission that has reached a native outcome. */
	protected nativeCommitAttemptEnded(): void {}

	/**
	 * True when a commit attempt is parked on this link that can no longer land: it never submitted, and
	 * the link is poisoned, so performCommit()'s post-await poison check throws before it commits. The
	 * monitor's commit-phase grace exists to let real pre-commit work finish; extending it to an attempt
	 * with no outcome left only pins this link's read snapshot for the rest of the grace.
	 */
	commitAttemptDoomedByPoison(): boolean {
		return !this.nativeCommitSubmitted && !this.poisonedMidCommit && Boolean(this.timedOut || this.disconnected);
	}

	/**
	 * Admission for a new write on behalf of a request. A request already cancelled poisons the chain
	 * (releasing whatever it staged) and is refused; otherwise the chain subscribes to the cancellation
	 * for as long as it owns writes, so a disconnect releases its intents at once instead of when its
	 * scope or pre-commit work happens to finish. Reads never subscribe.
	 */
	admitRequestWrite(): void {
		if (isReadOnlyMode()) throw readOnlyModeError();
		const root = this.root ?? this;
		const signal = root.requestSignal;
		if (!signal) return;
		if (signal.aborted) {
			this.abortDueToDisconnect();
			throw requestAbortedError();
		}
		if (root.requestAbortListener) return;
		const listener = () => {
			root.requestAbortListener = undefined;
			try {
				// isCommittingWrites() is not redundant: commit() marks itself CLOSED and clears its staged
				// writes before the native commit settles, so for that window the chain reads as idle.
				if ((root.open === TRANSACTION_STATE.OPEN && root.hasPendingWrites()) || root.isCommittingWrites())
					root.abortDueToDisconnect();
			} catch (error) {
				harperLogger.debug?.('aborting transaction on client disconnect', error);
			}
		};
		root.requestAbortListener = listener;
		signal.addEventListener('abort', listener, ONCE);
	}

	protected releaseRequestAbortListener(): void {
		const listener = this.requestAbortListener;
		if (!listener) return;
		this.requestAbortListener = undefined;
		this.requestSignal.removeEventListener('abort', listener);
	}

	/** Protected work has no proven resume path, so the monitor may observe but never poison it. */
	isProtectedCommit(): boolean {
		const root = this.root ?? this;
		let attached = false;
		for (let txn: DatabaseTransaction = root; txn; txn = txn.next) {
			if (txn.sourceApply || txn.isReplay) return true;
			if (txn === this) attached = true;
		}
		return !attached && Boolean(this.sourceApply || this.isReplay);
	}

	/**
	 * Reclaim only read resources that are separate from already-submitted writes. Never run this on a
	 * pre-submit link: its native read handle can still carry the write batch the commit needs.
	 */
	releaseStalledCommitReadResources(): void {
		const release = (txn: DatabaseTransaction) => {
			if (!txn.nativeCommitSubmitted || txn.stalledCommitResourcesReleased) return;
			txn.stalledCommitResourcesReleased = true;
			if (txn.closeOwnedReadIterators() > 0)
				harperLogger.warn?.(
					`Read iterators held a submitted transaction's snapshot after its native commit stalled; releasing it, from table: ${
						(txn.db as any)?.name
					}`
				);
			if (txn.transaction || txn.readTxn) txn.releaseReadTxn();
		};
		const root = this.root ?? this;
		let attached = false;
		for (let txn: DatabaseTransaction = root; txn; txn = txn.next) {
			release(txn);
			if (txn === this) attached = true;
		}
		if (!attached) release(this);
	}

	private endCommitAttempt(): void {
		this.commitsInFlight--;
		if (!this.commitsInFlight) {
			this.clearActiveCommitHandles();
			this.commitStartedAt = undefined;
			if (this.commitOverdueLogged) this.commitOverdueLogged = undefined;
			this.nativeCommitSubmitted = false;
			this.nativeCommitAttemptEnded();
		}
		// A link closes its OWN iterators the moment its own attempt settles, without waiting for the
		// chain: LMDBTransaction's commit detaches `next` before awaiting the child, so a scope abandoned
		// in that window never captured this link and the chain-wide cleanup below cannot reach it. Safe
		// here and not earlier because this link's attempt is the one that just reached its outcome.
		if ((this.root ?? this).scopeAbandoned) this.closeOwnedReadIterators();
		if (this.isChainCommitting()) return;
		// The window has closed: a commit entered from here on is a fresh one, and the flags that landed
		// during the finished attempt must reject it like any other poisoned commit.
		const root = this.root ?? this;
		root.committingWrites = false;
		root.commitSubmitted = false;
		root.submittedCommitSupervised = false;
		root.deferredPoisonDeadline = undefined;
		root.unsubmittedCommitDeadline = undefined;
		root.loggedRetriesSeen = undefined;
		root.loggedRetriesChangedAt = undefined;
		root.loggedRetriesTick = undefined;
		root.loggedRetryAdvancing = undefined;
		root.stalledCommitLogged = false;
		root.commitStartedAt = undefined;
		if (root.commitOverdueLogged) root.commitOverdueLogged = undefined;
		const submittedLink = root.submittedLink;
		root.submittedLink = undefined;
		const submittedLinks = root.submittedLinks;
		root.submittedLinks = undefined;
		if (submittedLink) clearAttemptState(submittedLink);
		if (submittedLinks) for (const txn of submittedLinks) clearAttemptState(txn);
		let stillWriteSupervised = false;
		for (let txn: DatabaseTransaction = root; txn; txn = txn.next) {
			clearAttemptState(txn);
			if (txn.writeSupervised) stillWriteSupervised = true;
		}
		if (!stillWriteSupervised) supervisedWriteRoots.delete(root);
		if (!root.hasPendingWrites()) root.releaseRequestAbortListener();
		if (root.scopeAbandoned) {
			root.scopeAbandoned = false;
			// The links captured when the scope was abandoned, not the current `next` chain: a successful
			// multi-store commit clears `next` before this runs, which would otherwise leave a former
			// child's iterators owning a snapshot nothing can reach.
			const abandoned = root.abandonedLinks;
			root.abandonedLinks = undefined;
			if (abandoned) for (const link of abandoned) link.closeOwnedReadIterators();
			else root.closeOwnedReadIterators();
		}
	}

	/**
	 * The scope that owned this transaction ended while a commit attempt was still in flight, so the
	 * wrapper could not abort it. Surrender scope ownership now, or the attempt's own
	 * rotateAfterMidScopeCommit reopens an instance with no wrapper left to commit or abort it and the
	 * next transaction() on that context joins it and never commits. Iterator cleanup is deferred to
	 * endCommitAttempt(), since closing them mid-attempt can pull the handle the commit is still
	 * staging through.
	 */
	abandonScope(): void {
		const root = this.root ?? this;
		root.scopeAbandoned = true;
		const links: DatabaseTransaction[] = [];
		for (let txn: DatabaseTransaction = this; txn; txn = txn.next) {
			links.push(txn);
			txn.endScopeOwnership();
			// Ending ownership alone only stops the attempt's own rotation; until it reaches its native
			// outcome the instance is still OPEN, and a hung `before` hook makes that window arbitrarily
			// long. Submitted attempts are monitor-deferred; a pre-submit attempt remains safely abortable.
			// Not on its own sufficient:
			// LMDBTransaction's own commit reassigns `open`, so the release below is what actually keeps
			// the next write on this context off an instance with no wrapper behind it.
			txn.open = TRANSACTION_STATE.CLOSED;
		}
		root.abandonedLinks = links;
		// By abort()'s own rule, so a poisoned chain stays joined and throws while an ordinary one lets
		// the next write start fresh.
		this.releaseContext(!this.timedOut && !this.disconnected);
	}

	/**
	 * Whether this chain has a write-bearing commit attempt in flight. `hasPendingWrites()` cannot
	 * answer that: commit() marks itself CLOSED and clears its staged writes well before the native
	 * commit settles, so between those points a write-bearing transaction looks read-only and idle to
	 * anything reading its public state — including transaction.ts's disconnect listener.
	 */
	isCommittingWrites(): boolean {
		return Boolean((this.root ?? this).committingWrites) && this.isChainCommitting();
	}

	protected performCommit(options: CommitOptions = {}): MaybePromise<CommitResolution> {
		// reused across retries — the native layer resets it in place (fresh snapshot) on IsBusy/TryAgain —
		// but reassigned to a fresh replay transaction when outstanding read iterators retain this.transaction
		let transaction = options.transaction ?? this.transaction;
		const retryRound = Boolean((options.transaction as RocksTransactionWithRetry)?.isRetry);
		const isImmediateCommit = Boolean((transaction as RocksTransactionWithRetry | undefined)?.immediateCommit);
		try {
			if (retryRound && this.activeCommitHandle && this.activeCommitHandle !== transaction) {
				this.backfillActiveHandleWrites(this.activeCommitHandle);
			}
			for (let i = 0; i < this.writes.length; i++) {
				let operation = this.writes[i];
				if (
					!operation ||
					(isImmediateCommit
						? !retryRound || !operation.saved || operation.stagedOn !== transaction
						: retryRound
							? !operation.saved || (Boolean(operation.stagedOn) && operation.stagedOn !== transaction)
							: Boolean(operation.saved) || (this.saveCommits && Boolean(operation.deferSave)))
				)
					continue;
				this.save(operation, transaction, Boolean(operation.saved) || i < this.validated, options);
				if (!transaction) transaction = this.transaction;
			}
			if (transaction && (this.writes.length > 0 || hasDurableLog(transaction)))
				this.trackActiveCommitHandle(transaction);
		} catch (error) {
			if (!transaction) transaction = this.transaction ?? undefined;
			// abort() releases only this.transaction; a retry round's handle was detached before its
			// first submission and would otherwise hold its write intents until GC.
			if (transaction && transaction !== this.transaction)
				abortNativeTransaction(
					transaction,
					'aborting a retry transaction whose re-save threw',
					this.writes[0]?.store ?? this.db,
					this.startedFrom
				);
			this.abort(false, true, transaction);
			throw error;
		}
		if (!isImmediateCommit) {
			this.validated = this.saveCommits
				? this.writes.reduce((acc, w, idx) => (w && (w.saved || !w.deferSave) ? idx + 1 : acc), 0)
				: this.writes.length;
		}
		const completions = this.takeCompletions(transaction);
		const stagedWrites = this.writes.length;
		let inCommitPhase = false;
		if (completions.length > 0 && !isImmediateCommit) {
			inCommitPhase = true;
			this.setCommitPhase(true);
		}
		let commitResult: MaybePromise<CommitResolution>;
		try {
			commitResult = when(completions.length > 0 ? Promise.all(completions) : null, () => {
				if (inCommitPhase) {
					inCommitPhase = false;
					this.setCommitPhase(false);
				}
				// The transaction can be aborted underneath us while we are parked in the await above — by the
				// monitor once the commit phase outlives its grace, or through the multi-store poison chain.
				// abort() cleared the write set and released the handle, so resuming would commit nothing and
				// resolve as SUCCESS: the caller is told its write landed when it was dropped, and a write
				// carrying a blob is left holding an instance whose file was unlinked (issue #2062).
				if (!this.poisonedMidCommit) {
					if (this.timedOut) throw transactionOpenTooLongError();
					if (this.disconnected) throw requestAbortedError();
				}
				if (stagedWrites > 0 && this.writes.length === 0 && this.open === TRANSACTION_STATE.CLOSED)
					throw new ServerError('Transaction was aborted while its commit was waiting on pre-commit work', 500);
				if (
					!retryRound &&
					!isImmediateCommit &&
					(this.saveCommits
						? this.writes.reduce((acc, w, idx) => (w && (w.saved || !w.deferSave) ? idx + 1 : acc), 0)
						: this.writes.length) > this.validated
				) {
					// check just in case we got any more transactions while we were waiting, if so just recursively continue to finish the additional writes now
					return this.commit({ ...options, continuation: true });
				}
				// The save loop above can be what opened this transaction's native handle — save() attaches
				// one when it had none, which is every ImmediateTransaction commit since its getReadTxn
				// opens none — leaving the local captured before the loop empty while that handle holds
				// every staged write, for the detach below to drop uncommitted (issue #2288). Only when
				// the local is empty: a truthy one is what the loop staged into, and the retained-handle
				// and replay branches below deliberately commit a handle other than this.transaction.
				if (!transaction) transaction = this.transaction;
				if (!options.transaction && this.hasSavedWrite()) this.renewChainForNativeCommit();
				if (!isImmediateCommit) this.open = TRANSACTION_STATE.CLOSED;
				// RocksTransaction.commit() resolves with RETRY_NOW_VALUE (a number) under
				// coordinatedRetry, or void on a normal commit/abort.
				let commitResolution: Promise<number | void> | void;
				// Consume this commit's own read reference — exactly once per read handle: retry
				// recursions, immediate-commit re-entries, and a second top-level commit() (wrapper
				// commit after an explicit in-handler commit) must not steal a reference owned by an
				// outstanding iterator (doneReadTxn() would then never release the native handle).
				if (!isImmediateCommit && !this.baseReadRefConsumed) {
					this.baseReadRefConsumed = true;
					this.readTxnsUsed--;
				}
				let hadLeaseProtectedWrite = false;
				if (!isImmediateCommit && this.readTxnsUsed > 0) {
					// Outstanding iterators still stream through this.transaction — their native iterators
					// live inside it (GetIterator wraps its write batch + snapshot), so committing or
					// aborting the handle now would invalidate them mid-stream. Leave it open for the
					// iterators (doneReadTxn() aborts it when the last one finishes) and commit the writes
					// NOW by replaying them onto a fresh transaction, the same shape as the ERR_TRY_AGAIN
					// replay below: entries reload through the new transaction and re-resolve against
					// current state, and conflicts surface through the normal retry ladder. Deferring the
					// native commit to doneReadTxn() instead (the old LINGERING state) meant anything that
					// kept the last iterator from finishing cleanly — a hung stream, the long-transaction
					// monitor's timeout abort — dropped writes the caller had already been told committed.
					this.writes = this.writes.filter((write) => write); // filter out removed entries
					if (this.hasSavedWrite() || hasDurableLog(transaction)) {
						if (!options.transaction) {
							if (!replayedWritesWarned) {
								replayedWritesWarned = true;
								harperLogger.warn?.(
									`Committing while read iterators are still open: ${this.writes.length} staged write(s) must be re-staged and committed on a second transaction, doubling their write work` +
										(this.startedFrom ? `, from ${this.startedFrom.resourceName}.${this.startedFrom.method}` : '') +
										`. Fully consume (or close) iterators before committing to avoid this. Logged once per process.`
								);
							}
							// Deliberately NOT marked isRetry and NOT carrying over the original's onCommit:
							// audit/txn-log entries batch natively on the transaction they were staged into and
							// are only durably written by that transaction's commit attempt (an abort discards
							// them — unlike the ERR_TRY_AGAIN replay below, where the original's FAILED commit
							// attempt already wrote its log batch). The original handle here never attempts a
							// commit, so the replayed stagings must re-append their entries into the replay
							// transaction's own batch — which also installs the replay's own commit hook.
							const replayTransaction = new RocksTransaction(
								(this.writes[0].store.store ?? this.db.store) as RocksStore,
								{ coordinatedRetry: true }
							);
							if (this.timestamp) replayTransaction.setTimestamp(this.timestamp);
							transferLocalKey(transaction, replayTransaction);
							const retries = ((transaction as RocksTransactionWithRetry | undefined)?.retries ?? this.retries) + 1;
							(replayTransaction as RocksTransactionWithRetry).retries = retries;
							this.retries = retries; // a replay round: commit handlers re-base on the reloaded entries
							const prevStagedTxnTime = this.getHandleStagedTxnTime(transaction);
							if (transaction) this.releaseActiveCommitHandle(transaction);
							this.trackActiveCommitHandle(replayTransaction);
							if (prevStagedTxnTime) this.setHandleStagedTxnTime(replayTransaction, prevStagedTxnTime);
							const abandoned = transaction;
							const abandonedLogged = hasDurableLog(abandoned);
							transaction = replayTransaction;
							try {
								for (const operation of this.writes) {
									if (!operation?.saved) continue;
									// A non-durable abandoned handle left no readable audit entry; a durable one may
									// have published its log and must retain the retry shield.
									if (operation.appendedTo === abandoned && !abandonedLogged) {
										operation.appendedAuditEntry = false;
										operation.appendedTo = undefined;
									}
									this.save(operation, replayTransaction, true, options);
								}
							} catch (error) {
								abortNativeTransaction(
									replayTransaction,
									'aborting a replay transaction whose re-save threw',
									this.writes[0]?.store ?? this.db,
									this.startedFrom
								);
								this.releaseActiveCommitHandle(replayTransaction);
								this.abort(
									false,
									true,
									this.hasSiblingCommitInFlight(replayTransaction) ? replayTransaction : undefined
								);
								throw error;
							}
						}
						// with options.transaction set this is a retry round — the save loop above already
						// re-staged the writes into it
						this.refuseUnconfirmable(transaction);
						this.assertDatabaseCommitAllowed(transaction);
						this.markNativeCommitSubmitted();
						commitResolution = transaction.commit() as Promise<void>;
						this.setHandleCommitInFlight(transaction, true);
						if (this.hasLeaseProtectedWrite) {
							hadLeaseProtectedWrite = true;
							this.retainTransactionLockHolds(transaction);
						}
						recordCommitLatency(commitResolution, performance.now());
						// Write-queue-depth accounting for this replay commit happens uniformly below, via
						// trackOutstandingCommit(commitResolution) — see that function's comment. Omitting
						// dedicated accounting here (as a prior version of this replay path did) used to leave
						// write-transaction-queue-depth, the one metric that can observe a commit that never
						// settles (harper#2001), reading zero for exactly this path.
					}
					// No commit will ever run on the retained handle — the replay above owns these
					// writes — so this is the only place its write intents can be released. Left in
					// place, other writers' coordinated-retry commits park on them until the last
					// iterator finishes (harper#2001). Reads through the handle, including
					// read-your-own-writes, keep working. Once only: a coordinated-retry or backoff
					// round re-enters this branch on the same retained handle. Fenced like the other
					// post-submit steps here: the replay commit is already in flight, so a throw must
					// not skip onCommit/the chain-store commit below. Optional: rocksdb-js < 2.7
					// lacks the method.
					this.releaseRetainedWriteIntents();
				} else {
					// no more reads need to be performed, just commit/abort based if there are any writes
					if (!isImmediateCommit) this.detachOwnedTransaction(); // any further operations operate immediately
					if (transaction) {
						this.writes = this.writes.filter((write) => write); // filter out removed entries
						if (this.hasSavedWriteForHandle(transaction, isImmediateCommit) || hasDurableLog(transaction)) {
							// Commit retries can construct fresh ranges on this live handle after read ownership ends.
							readTransactionOwners.delete(transaction);
							// Re-fence before submitting: the loop above skips operations already marked saved, so
							// save()'s own check cannot see a holder that stalled between staging and commit. The
							// retry/replay path re-saves every operation and is fenced there instead. Lease expiry
							// only: an unlock() inside the lease leaves the staged write valid, an elapsed lease
							// does not, whether or not the caller also unlocked.
							if (this.hasLeaseProtectedWrite && !hasDurableLog(transaction)) {
								for (let i = 0; i < this.writes.length; i++) {
									const write = this.writes[i];
									if (
										!write?.saved ||
										(isImmediateCommit
											? write.stagedOn !== transaction
											: Boolean(write.stagedOn) && write.stagedOn !== transaction)
									)
										continue;
									const lapsed = write.lockHandle;
									if (!lapsed?.isLeaseExpired()) continue;
									abortNativeTransaction(
										transaction,
										'aborting a transaction whose record lock lapsed before submission',
										this.writes[0]?.store ?? this.db,
										this.startedFrom
									);
									// Every other terminal exit from commit() runs the logical cleanup too. Throwing
									// straight out would strand the OTHER locks this transaction holds, its staged
									// blobs, and the context's back-reference to a CLOSED transaction — and
									// transaction()'s onComplete has no rejection path to run it later.
									try {
										this.abort(false, true, transaction);
									} catch (error) {
										harperLogger.debug?.('cleaning up a transaction whose record lock lapsed', error);
									}
									throw lockNotHeldError(lapsed);
								}
							}
							this.refuseUnconfirmable(transaction);
							// The transaction was created with coordinatedRetry:true (see
							// getReadTxn), so commit() can resolve to RETRY_NOW_VALUE. That
							// sentinel (a number) is why commitResolution is typed
							// Promise<number | void>; it is handled in the resolve callback below.
							this.assertDatabaseCommitAllowed(transaction);
							this.markNativeCommitSubmitted();
							commitResolution = transaction.commit();
							this.setHandleCommitInFlight(transaction, true);
							if (this.hasLeaseProtectedWrite) {
								hadLeaseProtectedWrite = true;
								this.retainTransactionLockHolds(transaction);
							}
							// Record how long this commit stays outstanding (submit → settle) as a distribution
							// metric. This is the same clock the overload check uses (trackOutstandingCommit
							// stamps each attempt at submit), so a rising p99/p999 is the leading indicator for the
							// "Outstanding write transactions have too long a queue" (503) rejection. A transient-
							// conflict retry rejects this promise and issues a fresh commit(), which is tracked as
							// its own attempt, so recording per attempt matches the overload semantics.
							// commitResolution's declared type (Promise<number | void> | void) doesn't narrow to
							// Promise<void> here because the widening union defeats flow analysis on the prior
							// cast assignment; re-assert it — this branch's commit() result is always a Promise.
							recordCommitLatency(commitResolution as Promise<void>, performance.now());
							// Write-queue-depth accounting for this commit happens uniformly below, via
							// trackOutstandingCommit(commitResolution) — see that function's comment. A
							// transient-conflict retry rejects this promise and issues a fresh commit()
							// (re-entering here), which trackOutstandingCommit tracks as its own attempt.
						} else {
							releaseLocalKey(transaction);
							try {
								commitResolution = transaction.abort();
							} catch (abortError) {
								if ((abortError as any)?.code === 'ERR_TRANSACTION_ABANDONED') {
									harperLogger.error?.(
										`Aborted a transaction with a durable log entry (empty write set), ${describeCommitIdentity(this.db, this.startedFrom, transaction)}`,
										abortError
									);
								}
								// The transaction has uncommitted writes that were already cleared from
								// this.writes by a concurrent immediate-commit path (e.g. writes made with
								// an explicitly-reused closed transaction). Those writes are handled by the
								// concurrent commit, so there is nothing left to do here.
							}
						}
					}
				}

				if (commitResolution) {
					// Read the table off the write itself, not this.db, which is whichever table first
					// claimed this per-database transaction in txnForContext and so can name the wrong
					// table when a transaction spans more than one table in the same database.
					trackOutstandingCommit(commitResolution, this.writes[0]?.store ?? this.db, this.startedFrom, transaction);
					// Every retry round and every chained store re-enters here and must inherit the chain
					// root's clock rather than restart it (or the per-handle clock on an unchained
					// ImmediateTransaction), so only the first submission stamps.
					const carrier = this.budgetCarrier(transaction);
					if (carrier.commitStartedAt == null) carrier.commitStartedAt = performance.now();
					const completions = [];
					const commitOutcome = commitResolution.then(
						(commitResult) => {
							const txnWithRetry = transaction as RocksTransactionWithRetry;
							if (commitResult === RETRY_NOW_VALUE) {
								this.setHandleCommitInFlight(transaction, false);
								const retries = (txnWithRetry.retries = (txnWithRetry.retries ?? 0) + 1);
								if (!isImmediateCommit || this.open !== TRANSACTION_STATE.OPEN) this.retries = retries;
								harperLogger.debug?.('coordinated retry', transaction.id, retries);
								// Mark this specific native transaction as a retry so RocksTransactionLogStore
								// skips re-writing its already-staged txn-log entries (#2).
								txnWithRetry.isRetry = true;
								const logged = hasDurableLog(transaction);
								const pastBudget = this.elapsedPastCommitBudget(transaction);
								if (pastBudget) {
									if (logged) this.noteOverdueLoggedCommit(transaction, pastBudget);
									else this.abandonCommitAfterDeadline(transaction, pastBudget);
								}
								if (retries > MAX_RETRIES && !this.sourceApply && !logged) {
									// giving up: poison and abort the whole linked chain so no link leaks its native
									// handle / read snapshot — or any unpublished transaction-log position — until GC.
									this.abortChainAfterRetries(transaction);
									throw new ServerError(
										`After ${MAX_RETRIES} coordinated retries, unable to commit transaction, transaction is in conflict with ongoing writes`
									);
								}
								if ((this.sourceApply || logged) && retries > 0 && retries % MAX_RETRIES === 0) {
									harperLogger.warn?.(
										`${this.sourceApply ? 'Source-applied' : 'Logged'} transaction ${transaction.id} still in conflict after ${retries} coordinated retries; continuing to retry`
									);
								}
								// Randomized so two uncapped logged commits crossing on the same keys stop waking in lockstep.
								if (logged && retries > 2) {
									const backoff = delay(Math.ceil(Math.min(retries * 2, MAX_RETRY_DELAY_MS) * Math.random()));
									trackOutstandingCommit(backoff, this.writes[0]?.store ?? this.db, this.startedFrom, transaction);
									return backoff.then(() => this.commit({ ...options, transaction }));
								}
								return this.commit({ ...options, transaction });
							}
							const committedTxnKey = reservedLocalKey(transaction);
							const committedLogKey = this.replicatedConfirmation ? committedTxnKey : undefined;
							const committedTransaction = transaction;
							const committedImmediate = Boolean(
								(committedTransaction as RocksTransactionWithRetry | undefined)?.immediateCommit
							);
							this.setHandleCommitted(transaction);
							releaseLocalKey(transaction);
							// onCommit may be async (e.g. RocksTransactionLogStore emits 'aftercommit'). Surface a
							// rejection — or a synchronous throw — via logging rather than failing the commit, since
							// the write is already durable.
							try {
								const onCommitResult = (transaction as any).onCommit?.();
								if (onCommitResult?.then)
									onCommitResult.catch((error) => harperLogger.warn?.('onCommit handler failed after commit', error));
							} catch (error) {
								harperLogger.warn?.('onCommit handler failed after commit', error);
							}
							if (this.recordLocks) this.noteCommittedLockVersions(committedTransaction);
							releaseTransactionLockHolds(transaction);
							if (
								committedImmediate
									? this.open !== TRANSACTION_STATE.OPEN && !this.hasSiblingCommitInFlight(committedTransaction)
									: !this.saveCommits || !this.hasSiblingCommitInFlight(committedTransaction)
							)
								this.releaseRecordLocks();
							if (this.next && !committedImmediate) {
								// never forward options.transaction (a retry/replay round's HEAD-store handle) to
								// the next store — it must commit its own writes through its own transaction
								let nextCommit: MaybePromise<CommitResolution>;
								try {
									nextCommit = this.next.commit({ ...options, transaction: undefined, continuation: true });
								} catch (error) {
									// This store has landed; its bookkeeping below must run before the failure surfaces.
									nextCommit = Promise.reject(error);
									nextCommit.catch(() => {}); // still rejects Promise.all, even if bookkeeping throws first
								}
								completions.push(nextCommit);
							}
							if (options?.flush) {
								const store = this.writes[0]?.store;
								if (store) completions.push(store.flushed);
							}
							let confirmation: Promise<void>;
							if (this.replicatedConfirmation) {
								// if we want to wait for replication confirmation, we need to track the transaction times
								// and when replication notifications come in, we count the number of confirms until we reach the desired number
								const databaseName = this.writes[0]?.store.rootStore.databaseName;
								// the write has landed: a refusal here is this commit's outcome, after the bookkeeping below
								try {
									const target =
										confirmReplication && databaseName
											? this.confirmationTarget(committedLogKey, committedTransaction)
											: undefined;
									if (target) {
										confirmation = confirmReplicationAfterCommit(() =>
											confirmReplication(
												databaseName,
												target.version,
												this.replicatedConfirmation,
												target.residentPeerLists
											)
										);
									}
								} catch (error) {
									const refusal = Promise.reject(error);
									refusal.catch(() => {}); // surfaces through local completions, even if bookkeeping throws first
									completions.push(refusal);
								}
							}
							// commit succeeded; clean up files for any writes whose commit-handler took an early-return,
							// or whose stored record a later write to the same key replaced without an audit entry
							// keeping its blobs reachable (checked against the final committed record, so a blob the
							// later write retained survives). Deferred until here so a retry that *would* have
							// referenced the blob can flip skipped/superseded back to false first.
							for (const write of this.writes) {
								if (!write?.saved || !write.savedBlobs) continue;
								if (
									committedImmediate
										? write.stagedOn !== committedTransaction
										: Boolean(write.stagedOn) && write.stagedOn !== committedTransaction
								)
									continue;
								if (
									(write.skipped &&
										!(
											write.blobsAuditReferenced &&
											(write.appendedTo === committedTransaction || hasDurableLog(write.appendedTo))
										)) ||
									(write.superseded && !write.blobsAuditReferenced)
								)
									cleanupUnusedBlobs(write.savedBlobs, collectRetainedFileIds(write.store.getEntry(write.key)?.value));
							}
							const committedStagedTxnTime = this.getHandleStagedTxnTime(committedTransaction);
							// now reset transactions tracking; this transaction be reused and committed again
							this.clearWrites(committedTransaction);
							if (!committedImmediate) {
								this.retries = 0;
								if (options.doneWriting) this.endScopeOwnership();
								this.releaseContext(!!options.doneWriting);
							}
							let txnTime = committedStagedTxnTime || this.timestamp || committedTxnKey || 0;
							if (
								(!committedImmediate || this.open !== TRANSACTION_STATE.OPEN) &&
								this.writes.length === 0 &&
								!this.hasActiveCommitHandle()
							)
								this.timestamp = 0; // reset the timestamp as well
							const completed =
								confirmation || (this.root ?? this).replicatedConfirmation
									? settleCommitCompletions(completions, confirmation)
									: Promise.all(completions);
							return completed.then(
								() => {
									// Only once the chained store's commit has settled, as on the synchronous path: a
									// partially failed mid-scope commit must not leave the scope resumable.
									this.completeMidScopeCommit(options, committedTransaction);
									return {
										txnTime,
									};
								},
								(error) => {
									// As on the synchronous path: a completion that failed (a chained store's commit,
									// a replication confirmation) leaves this commit partly landed, so ownership goes
									// with it rather than letting a later commit rotate on top.
									(committedTransaction as RocksTransactionWithRetry).committed = true;
									if (!committedImmediate) this.endScopeOwnership();
									throw error;
								}
							);
						},
						(error) => {
							const txnWithRetry = transaction as RocksTransactionWithRetry;
							this.setHandleCommitInFlight(transaction, false);
							// Coordinated transactions surface conflicts as RETRY_NOW (handled in the
							// resolve branch above) and never reach here with ERR_BUSY. But not every
							// write transaction is coordinated — a write that reaches save() with no
							// prior getReadTxn() (immediate/publish/invalidate writes) is created
							// without coordinatedRetry and still rejects with ERR_BUSY on conflict.
							// Keep the backoff retry as the fallback for those paths.
							//
							// ERR_BUSY: optimistic-transaction write conflict. ERR_TRY_AGAIN: RocksDB kTryAgain —
							// the transaction's snapshot sequence fell outside the memtable conflict-check window
							// (max_write_buffer_size_to_maintain), which happens under bulk-ingest bursts such as a
							// migration full-table copy. Both are transient and retryable. Before ERR_TRY_AGAIN was
							// retried here, the rejection propagated out of the unawaited onCommit() handler as an
							// unhandled rejection and the write was silently dropped — records lost mid-copy (#308).
							if (error.code === 'ERR_BUSY' || error.code === 'ERR_TRY_AGAIN') {
								// if the transaction failed due to concurrent changes, we need to retry. First record this as an increased risk of contention/retry
								// for future transactions
								const retries = (txnWithRetry.retries = (txnWithRetry.retries ?? 0) + 1);
								if (!isImmediateCommit || this.open !== TRANSACTION_STATE.OPEN) this.retries = retries;
								harperLogger.debug?.('retrying', transaction.id, retries);
								// ERR_BUSY and ERR_TRY_AGAIN are both retried by recommitting the SAME native
								// transaction. ERR_BUSY recovers because the save loop re-writes each key, re-tracking
								// it at the current sequence. ERR_TRY_AGAIN — a snapshot stranded outside the memtable
								// conflict-check window after a bulk-ingest flush — used to fail forever on recommit
								// because the native layer left the stranded snapshot in place; rocksdb-js now resets
								// the transaction onto a fresh snapshot on the failed TryAgain commit, exactly as it
								// always did for IsBusy, so the re-run's save loop re-resolves against current state and
								// converges. Keeping the same transaction means its committedPosition survives the reset
								// (WAL write-once, rocksdb-js#668) and its onCommit hook stays attached, so the
								// already-staged change-feed entry publishes only when the retry really commits — no
								// premature publish, and no fresh-transaction replay that would drop the entry.
								// Mark the native transaction as a retry so RocksTransactionLogStore skips re-staging entries.
								txnWithRetry.isRetry = true;
								if ((error as any)?.hasLog === true) {
									txnWithRetry.hasStagedLog = true;
								}
								const logged = hasDurableLog(transaction, error as any);
								// Before the backoff gate below: the budget can already be spent on the first
								// retry when an earlier store in this chain consumed it.
								const pastBudget = this.elapsedPastCommitBudget(transaction);
								if (pastBudget) {
									if (logged) this.noteOverdueLoggedCommit(transaction, pastBudget);
									else this.abandonCommitAfterDeadline(transaction, pastBudget);
								}
								if (retries > 2) {
									// Transactions applying data from a canonical source of truth (replication peer or
									// external caching source) must never drop a write on a transient conflict: there is no
									// re-subscribe / sequence-id-resume path, so a dropped write would leave this node
									// permanently diverged (harper-pro#348). Such transactions retry without a cap; the source
									// apply loop serializes commits (backpressure), so contention clears rather than
									// compounding. Durably logged transactions likewise retry without a cap so a written
									// transaction-log entry is never abandoned.
									const neverDropOnConflict = this.sourceApply || logged;
									if (retries > MAX_RETRIES && !neverDropOnConflict) {
										// giving up: poison and abort the whole linked chain so no link leaks its native
										// handle / read snapshot until GC.
										this.abortChainAfterRetries(transaction);
										throw new ServerError(
											`After ${MAX_RETRIES} retries, unable to commit transaction, transaction is in conflict with ongoing writes`
										);
									}
									// Uncapped retry can otherwise stall silently (debug logging is off in production);
									// surface periodic visibility into a stalled source-apply or logged commit.
									if (neverDropOnConflict && retries % MAX_RETRIES === 0) {
										harperLogger.warn?.(
											`${this.sourceApply ? 'Source-applied' : 'Logged'} transaction ${transaction.id} still in conflict after ${retries} retries; continuing to retry`
										);
									}
									// start delaying, back off to try to space out transactions and avoid excessive conflicts
									const backoff = delay(Math.min(retries * retries, MAX_RETRY_DELAY_MS));
									if (logged) {
										// waitForDrain() must outlast the backoff too
										trackOutstandingCommit(backoff, this.writes[0]?.store ?? this.db, this.startedFrom, transaction);
									}
									return backoff.then(() => this.commit({ ...options, transaction }));
								}
								return this.commit({ ...options, transaction }); // try again
							} else {
								// terminal (non-conflict) failure: release the native handle so it doesn't leak;
								// usually already released by the failed commit itself, abort for the unexpected
								// case (same defensive pattern as the retry-exhaustion give-up above)
								if ((error as any)?.hasLog) {
									txnWithRetry.isRetry = true;
									txnWithRetry.hasStagedLog = true;
								}
								abortNativeTransaction(
									transaction,
									'aborting transaction after failed commit',
									this.writes[0]?.store ?? this.db,
									this.startedFrom
								);
								// A terminal failure is just as final as a success — release the context's
								// back-reference while handling the native transaction. performCommit's outer
								// rejection handler then aborts the wrapper and its linked chain.
								// A failed commit must never be followed by a resumed segment: this generation is
								// finished and its durability is unknown, so ownership goes with it.
								if (
									!isImmediateCommit &&
									!this.hasWriteOwnedByActiveCommit(transaction, this.hasSiblingCommitInFlight(transaction), true, true)
								) {
									this.endScopeOwnership();
									this.releaseContext(!!options.doneWriting);
								}
								if (!hasDurableLog(transaction, error as any)) {
									if (
										!isImmediateCommit &&
										!this.saveCommits &&
										this.writes.some((write) => write && (!write.stagedOn || write.stagedOn === transaction))
									)
										(this.root ?? this).writesRolledBack = true;
									for (const write of this.writes) {
										if (
											!write?.saved ||
											!write.savedBlobs ||
											(isImmediateCommit
												? write.stagedOn !== transaction
												: Boolean(write.stagedOn) && write.stagedOn !== transaction)
										)
											continue;
										cleanupUnusedBlobs(
											write.savedBlobs,
											collectRetainedFileIds(write.store.getEntry(write.key)?.value)
										);
									}
								}
								this.clearWrites(transaction);
								releaseTransactionLockHolds(transaction);
								if (
									(!isImmediateCommit || this.open !== TRANSACTION_STATE.OPEN) &&
									!this.hasActiveCommitHandle() &&
									this.writes.length === 0
								)
									this.releaseRecordLocks();
								if ((!isImmediateCommit || this.open !== TRANSACTION_STATE.OPEN) && !this.hasActiveCommitHandle())
									this.timestamp = 0;
								throw error;
							}
						}
					);
					// Release any lock holds remaining if `commitOutcome` rejects (for example when a chained
					// store's commit or a completion fails) through the returned promise rather than a second
					// subscriber that would mark an unawaited commit rejection as handled.
					if (!hadLeaseProtectedWrite) return commitOutcome;
					return commitOutcome.then(undefined, (error) => {
						releaseTransactionLockHolds(transaction);
						throw error;
					});
				}
				for (const write of this.writes) {
					if (!write?.saved) continue;
					if (
						isImmediateCommit
							? write.stagedOn !== transaction
							: this.hasSiblingCommitInFlight(transaction) && Boolean(write.stagedOn) && write.stagedOn !== transaction
					)
						continue;
					if (
						write.savedBlobs &&
						((write.skipped &&
							!(write.blobsAuditReferenced && (write.appendedTo === transaction || hasDurableLog(write.appendedTo)))) ||
							(write.superseded && !write.blobsAuditReferenced))
					)
						cleanupUnusedBlobs(write.savedBlobs, collectRetainedFileIds(write.store.getEntry(write.key)?.value));
				}
				if (this.recordLocks) this.noteCommittedLockVersions(transaction);
				const committedStagedTxnTime = this.getHandleStagedTxnTime(transaction);
				this.clearWrites(transaction);
				if (
					isImmediateCommit
						? this.open !== TRANSACTION_STATE.OPEN && !this.hasActiveCommitHandle() && this.writes.length === 0
						: !this.saveCommits || (!this.hasActiveCommitHandle() && this.writes.length === 0)
				)
					this.releaseRecordLocks();
				if (!isImmediateCommit) {
					if (options.doneWriting) this.endScopeOwnership();
					this.releaseContext(!!options.doneWriting);
				}
				const txnResolution: CommitResolution = {
					txnTime: committedStagedTxnTime || this.timestamp,
				};
				if (
					(!isImmediateCommit || this.open !== TRANSACTION_STATE.OPEN) &&
					this.writes.length === 0 &&
					!this.hasActiveCommitHandle()
				)
					this.timestamp = 0;
				if (this.next && !isImmediateCommit) {
					// now run any other transactions
					options.timestamp = txnResolution.txnTime;
					// as above: the next store must not inherit this store's explicit native transaction
					let nextResolution;
					try {
						nextResolution = this.next?.commit({ ...options, transaction: undefined, continuation: true });
					} catch (error) {
						// A synchronous throw reaches neither rejection handler below, and the head has already
						// committed — surrender ownership here too, or the scope stays resumable on top of a
						// half-landed multi-store commit.
						this.endScopeOwnership();
						throw error;
					}
					if ((nextResolution as any)?.then)
						return (nextResolution as any)?.then(
							(nextResolution) => {
								// Only once the chained store's own commit has SETTLED: rotating first would leave the
								// scope resumable after a partially failed mid-scope commit.
								this.completeMidScopeCommit(options, transaction);
								return {
									txnTime: txnResolution.txnTime,
									next: nextResolution,
								};
							},
							(error) => {
								// A chained store's commit failed, so this multi-store commit half-landed. Surrender
								// ownership as the head's own failure branch does: a handler that catches this and
								// commits again must not rotate on top of it, and must not have the failed link
								// dropped from the chain before its abort can clean up its blobs.
								this.endScopeOwnership();
								throw error;
							}
						);
					txnResolution.next = nextResolution as any;
				}
				this.completeMidScopeCommit(options, transaction);
				return txnResolution;
			});
		} catch (error) {
			if (inCommitPhase) this.setCommitPhase(false);
			this.abortAfterCommitError(error, transaction);
		}
		if ((commitResult as Promise<CommitResolution>)?.then)
			return (commitResult as Promise<CommitResolution>).catch((error) => {
				if (inCommitPhase) this.setCommitPhase(false);
				this.abortAfterCommitError(error, transaction);
			});
		return commitResult;
	}
	/**
	 * A successful commit that is NOT the scope's final one leaves the scope still running and still
	 * responsible for a commit. Rotate to a fresh OPEN generation so the rest of the scope's writes
	 * stage into it and are committed — or rolled back — as one unit, instead of each committing itself
	 * the moment it is made. Every dispatch path keeps its plain `open === OPEN` check; CLOSED never
	 * gains a second meaning.
	 *
	 * Deliberately not rotated when: the scope is finished (`doneWriting`), nothing owns this instance,
	 * a timeout poisoned it, or a commit failed — a failed or uncertain commit must never be followed by
	 * a resumed segment that can commit on its own. Nor when read iterators still hold the native
	 * handle: that handle belongs to them until they drain, so there is nothing to rotate into and those
	 * writes keep today's immediate-commit path.
	 */
	/**
	 * Finish a commit: the chain goes with it, then the scope may rotate. A link left attached and CLOSED
	 * would be reused by txnForContext for the next write to that database and commit itself, surviving a
	 * rollback of the rotated head — the cross-store leftover this rotation exists to prevent. Every
	 * commit path must run this, and none may do one half without the other.
	 */
	/** Both scope flags leave together, so no exit can clear one and keep the other. */
	protected endScopeOwnership(): void {
		this.#scopeOwned = false;
		this.snapshotFree = false;
	}

	private completeMidScopeCommit(options: CommitOptions, committedTransaction?: RocksTransaction | null): void {
		if ((committedTransaction as RocksTransactionWithRetry | null | undefined)?.immediateCommit) return;
		this.next = null;
		if (this.saveCommits && this.hasActiveCommitHandle()) return;
		this.rotateAfterMidScopeCommit(options);
	}

	/** See completeMidScopeCommit, which is the only caller and carries the reasoning. */
	private rotateAfterMidScopeCommit(options: CommitOptions): void {
		if (
			options.doneWriting ||
			this.timedOut ||
			this.disconnected ||
			this.postSubmitPoisoned ||
			this.transaction ||
			!this.#scopeOwned
		)
			return;
		this.open = TRANSACTION_STATE.OPEN;
		this.snapshotFree = true;
		this.writesAbandoned = false;
		if (this.#context && (this.#context.transaction === this || this.#context.transaction === RELEASED_TRANSACTION)) {
			this.#context.transaction = this;
		}
	}

	private assertDatabaseCommitAllowed(transaction: RocksTransaction): void {
		if (hasDurableLog(transaction)) return;
		const rootStore = this.writes[0]?.store?.rootStore;
		if (!databaseCommitsSuspended(rootStore)) return;
		const retryable = !this.root && !this.snapshotFree;
		if (this.transaction === transaction) this.detachOwnedTransaction();
		abortNativeTransaction(
			transaction,
			'aborting a transaction while its database is closing',
			this.writes[0]?.store ?? this.db,
			this.startedFrom
		);
		try {
			this.abort(false, true, transaction);
		} catch (error) {
			harperLogger.debug?.('cleaning up a transaction while its database is closing', error);
		}
		throw new DatabaseClosingError(rootStore?.databaseName ?? rootStore?.path ?? 'unknown', retryable);
	}

	protected abortAfterCommitError(error, targetTransaction?: RocksTransaction): never {
		try {
			if (error?.replicationUnconfirmed === true && (this.hasPendingWrites() || (this.root ?? this).writesRolledBack))
				error = withoutReplicationUnconfirmed(error);
		} catch {}
		try {
			const retryTxn = targetTransaction as RocksTransactionWithRetry | undefined;
			const retryTxnCommitted = this.isHandleCommitted(retryTxn);
			const retryTxnInFlight = this.isHandleCommitInFlight(retryTxn);
			if (retryTxn && retryTxnCommitted) retryTxn.committed = true;
			if (retryTxn) this.releaseActiveCommitHandle(retryTxn);
			if (retryTxn && retryTxn !== this.transaction && !retryTxnCommitted && !retryTxnInFlight) {
				releaseTransactionLockHolds(retryTxn);
				abortNativeTransaction(
					retryTxn,
					'aborting a retry transaction after pre-commit failure',
					this.writes[0]?.store ?? this.db,
					this.startedFrom
				);
			}
			// Not "always retain": abort(true) keeps the native handle only while read iterators still
			// own it. resources/transaction.ts's own post-error abort passes the same argument, so the
			// two layers cannot contradict each other one frame apart.
			this.abort(true, true, targetTransaction);
		} catch (abortError) {
			harperLogger.debug?.('aborting transaction after a failed commit', abortError);
		}
		throw error;
	}
	abort(retainReadTransaction = false, cascade = true, targetTransaction?: RocksTransaction): void {
		const nativeTxn = targetTransaction ?? this.transaction;
		const isImmediateTarget = Boolean((targetTransaction as RocksTransactionWithRetry | undefined)?.immediateCommit);
		const hasSiblingInFlight = this.hasSiblingCommitInFlight(targetTransaction);
		const preserveActiveWrites =
			isImmediateTarget || this.hasWriteOwnedByActiveCommit(targetTransaction, hasSiblingInFlight, true);
		const preserveNonImmediateActiveWrites =
			isImmediateTarget || this.hasWriteOwnedByActiveCommit(targetTransaction, hasSiblingInFlight, true, true);
		if (
			this.writes.length > 0 &&
			!isImmediateTarget &&
			!this.saveCommits &&
			this.hasWriteToDiscard(nativeTxn, targetTransaction, hasSiblingInFlight, preserveActiveWrites)
		)
			(this.root ?? this).writesRolledBack = true;
		const cascadeNext = cascade && !preserveNonImmediateActiveWrites;
		const next = cascadeNext ? this.next : undefined;
		if (cascadeNext && !retainReadTransaction) this.next = null;
		try {
			const ownsCurrentTransaction =
				!isImmediateTarget && (!hasSiblingInFlight || !targetTransaction || this.transaction === targetTransaction);
			const currentTxn = this.transaction as RocksTransactionWithRetry | null | undefined;
			const currentTxnActive =
				Boolean(currentTxn) &&
				!currentTxn.abortedByWrapper &&
				!this.isHandleCommitted(currentTxn) &&
				(this.isHandleCommitInFlight(currentTxn) ||
					hasDurableLog(currentTxn) ||
					(Boolean(targetTransaction) && currentTxn !== targetTransaction && this.isActiveCommitHandle(currentTxn)));
			if (ownsCurrentTransaction && !currentTxnActive) {
				if (this.transaction) this.releaseActiveCommitHandle(this.transaction);
				const hasOpenReadIterator =
					retainReadTransaction &&
					this.transaction &&
					(this.readTxnsUsed > 1 || (this.baseReadRefConsumed && this.readTxnsUsed > 0));
				if (hasOpenReadIterator) {
					this.releaseRetainedWriteIntents();
					if (!this.baseReadRefConsumed) {
						this.doneReadTxn();
						this.baseReadRefConsumed = true;
					}
				} else {
					while (this.transaction && this.readTxnsUsed > 0) this.doneReadTxn(); // release the read snapshot when we abort, we assume we don't need it
				}
				// A write-only transaction never took a read reference (getReadTxn was never called), so the
				// loop above releases nothing even though save() created a native handle. Keep an iterator's
				// handle alive, but release every other remaining handle through the shared cleanup path.
				if (this.transaction && !hasOpenReadIterator) this.releaseReadTxn();
			}
			if (!isImmediateTarget) this.open = TRANSACTION_STATE.CLOSED;
			this.drainCompletions(targetTransaction, preserveActiveWrites);
			const targetLogged = hasDurableLog(targetTransaction);
			for (const write of this.writes) {
				if (!write) continue;
				if (preserveActiveWrites && this.isWriteOwnedByActiveCommit(write, targetTransaction, hasSiblingInFlight, true))
					continue;
				if (
					targetLogged &&
					write.saved &&
					(isImmediateTarget
						? write.stagedOn === targetTransaction
						: !write.stagedOn || write.stagedOn === targetTransaction)
				)
					continue;
				if (write.savedBlobs)
					cleanupUnusedBlobs(write.savedBlobs, collectRetainedFileIds(write.store.getEntry(write.key)?.value));
			}
		} finally {
			try {
				if (!isImmediateTarget) this.open = TRANSACTION_STATE.CLOSED;
				const endScopeOnAbort = !isImmediateTarget && (!targetTransaction || !preserveNonImmediateActiveWrites);
				if (endScopeOnAbort) this.endScopeOwnership(); // the scope is over; nothing may rotate this instance again
				this.clearWrites(targetTransaction, true);
				if (targetTransaction) {
					releaseTransactionLockHolds(targetTransaction);
				}
				if ((!isImmediateTarget || this.open !== TRANSACTION_STATE.OPEN) && !this.hasActiveCommitHandle()) {
					this.timestamp = 0; // a lock stamp pinned for this write set must not leak into the next
					this.retries = 0;
				}
				if (
					(isImmediateTarget
						? this.open !== TRANSACTION_STATE.OPEN && !this.hasActiveCommitHandle()
						: !preserveActiveWrites) &&
					this.writes.length === 0
				) {
					releaseTransactionLockHolds(nativeTxn);
					if (this.transaction && this.transaction !== nativeTxn) releaseTransactionLockHolds(this.transaction);
					this.releaseRecordLocks();
				}
				// A timeout-poisoned abort (abortDueToTimeout()) is the one abort that is NOT "reuse-free":
				// Resource.ts's dispatcher deliberately keeps joining a `timedOut` transaction (instead of
				// starting a fresh one) so the rest of the logical operation fails atomically via the
				// poison check in addWrite()/commit(), rather than silently landing a later write on a
				// brand-new transaction after an earlier one was rolled back (#1411). Releasing here would
				// make that check see `undefined?.timedOut` and take the "start fresh" branch instead.
				if (endScopeOnAbort) {
					this.releaseContext(!this.timedOut && !this.disconnected);
					if (!this.root) this.releaseRequestAbortListener();
				}
			} finally {
				if (next && !(next.nativeCommitSubmitted && next.commitsInFlight)) {
					try {
						next.abort(retainReadTransaction);
					} catch (error) {
						harperLogger.debug?.('cleaning up a chained transaction during abort', error);
					}
				}
			}
		}
	}
	/** How long this logical commit may keep retrying: the thread-wide queue limit, or its own larger explicit budget. */
	private commitConflictBudget(): number {
		return Math.max(MAX_OUTSTANDING_TXN_DURATION, (this.root ?? this).timeoutBudget || 0);
	}

	/**
	 * How long this logical commit has been retrying once it is past its budget, else 0. rocksdb-js
	 * returns control from a parked commit every `ROCKSDB_JS_PARK_TIMEOUT_MS` even when the intent
	 * holder never releases, so without this bound a request-path commit retries the attempt cap out
	 * — minutes past the queue limit an operator configured (issue #2450).
	 *
	 * Source-applied writes are exempt for the same reason they are exempt from the attempt cap:
	 * there is no resubscribe/sequence-resume path, so dropping one permanently diverges this node.
	 */
	private elapsedPastCommitBudget(transaction?: RocksTransaction): number {
		if (this.sourceApply) return 0;
		const startedAt = this.budgetCarrier(transaction).commitStartedAt;
		if (startedAt == null) return 0;
		const elapsed = performance.now() - startedAt;
		return elapsed > this.commitConflictBudget() ? elapsed : 0;
	}

	/**
	 * Abandon a logical commit that stayed in write-intent conflict past its budget. Cleanup is
	 * retry exhaustion's, so no link leaks a native handle or read snapshot; the error is distinct
	 * because the condition is distinct — every attempt reported transient contention, so a later
	 * request can succeed once the holder releases, which the generic exhaustion 500 does not say.
	 *
	 * Only a chain root may report `retryable`: a link commits solely from its predecessor's success
	 * handler, so anywhere else in the chain an earlier store has already landed durable audit
	 * entries and hooks that a replayed request would run twice. A head whose scope already rotated
	 * through a mid-scope commit is in the same position.
	 */
	private abandonCommitAfterDeadline(headTransaction: RocksTransaction, elapsedMs: number): never {
		const elapsed = Math.round(elapsedMs);
		const budget = this.commitConflictBudget();
		const retryable = !this.root && !this.snapshotFree;
		const retries = (headTransaction as RocksTransactionWithRetry | undefined)?.retries ?? this.retries;
		if (allowStuckCommitLog('abandon', performance.now())) {
			let headTransactionId;
			try {
				headTransactionId = headTransaction?.id;
			} catch {}
			harperLogger.error?.(
				`Abandoning a write transaction: its commit has been in write-intent conflict for ${elapsed}ms ` +
					`(exceeds the ${budget}ms limit) across ${retries} retries, ` +
					describeCommitIdentity(this.writes[0]?.store, this.startedFrom, headTransaction) +
					`.` +
					describeHolderCandidates(this.writes[0]?.store?.rootStore?.path, headTransactionId) +
					` Another transaction holds a conflicting write intent and has not completed; the request is ` +
					`failed with a 503${retryable ? '' : ' (not retryable — an earlier store in this transaction already committed)'} ` +
					`rather than waiting further.`
			);
		}
		this.abortChainAfterRetries(headTransaction);
		throw new TransactionCommitConflictTimeoutError(
			`Commit was in conflict with ongoing writes for ${elapsed}ms, exceeding the ${budget}ms limit; transaction abandoned after ${retries} retries`,
			retryable
		);
	}

	/**
	 * A durably logged commit past its conflict budget cannot be aborted; release its deferred
	 * record-lock holds (`holdBudgetSpent` prevents re-retaining them) and log once per chain/cooldown.
	 */
	private noteOverdueLoggedCommit(headTransaction: RocksTransaction, elapsedMs: number): void {
		(headTransaction as RocksTransactionWithRetry).holdBudgetSpent = true;
		releaseTransactionLockHolds(headTransaction);
		const carrier = this.budgetCarrier(headTransaction);
		if (carrier.commitOverdueLogged) return;
		if (!allowStuckCommitLog('overdue', performance.now())) return;
		carrier.commitOverdueLogged = true;
		const elapsed = Math.round(elapsedMs);
		const budget = this.commitConflictBudget();
		const retries = (headTransaction as RocksTransactionWithRetry | undefined)?.retries ?? this.retries;
		let headTransactionId;
		try {
			headTransactionId = headTransaction?.id;
		} catch {}
		harperLogger.error?.(
			`A durably logged write transaction is still in write-intent conflict after ${elapsed}ms ` +
				`(exceeds the ${budget}ms limit) across ${retries} retries, ` +
				describeCommitIdentity(this.writes[0]?.store, this.startedFrom, headTransaction) +
				`.` +
				describeHolderCandidates(this.writes[0]?.store?.rootStore?.path, headTransactionId) +
				` Because its transaction-log entry is already durable on disk, it cannot be aborted and ` +
				`will continue retrying until the conflicting write intent releases (pinning the local ` +
				`transaction-log read watermark for subscriptions and replication while uncommitted).`
		);
	}

	/**
	 * Give up on a chain of linked transactions after exhausting conflict retries: poison every link
	 * first, then abort each link's native transaction and release its DatabaseTransaction-level
	 * resources. Two passes (mirroring abortDueToTimeout) so a throw while aborting one link can't leave
	 * later links (this.next) holding native handles / read snapshots until GC. `headTransaction` is the
	 * head link's native transaction, which commit() detached to a local before this point, so it is
	 * aborted directly; every other link still owns its native transaction on `txn.transaction`. The
	 * head can also own a retained read handle from commit()'s outstanding-iterators branch, separate
	 * from the replay transaction; retry exhaustion aborts both.
	 */
	abortChainAfterRetries(headTransaction: RocksTransaction): void {
		const isImmediateCommit = Boolean((headTransaction as RocksTransactionWithRetry | undefined)?.immediateCommit);
		const hasSiblingInFlight = this.hasSiblingCommitInFlight(headTransaction);
		if (
			isImmediateCommit ||
			(hasSiblingInFlight && this.hasWriteOwnedByActiveCommit(headTransaction, hasSiblingInFlight, true, true))
		) {
			if (!isImmediateCommit && this.transaction === headTransaction) this.detachOwnedTransaction();
			releaseTransactionLockHolds(headTransaction);
			abortNativeTransaction(
				headTransaction,
				'aborting conflicted transaction in chain after exhausting retries',
				this.writes[0]?.store ?? this.db,
				this.startedFrom
			);
			try {
				this.abort(false, false, headTransaction);
			} catch (abortError) {
				harperLogger.debug?.('cleaning up conflicted transaction in chain after exhausting retries', abortError);
			}
			return;
		}
		for (let txn: DatabaseTransaction = this; txn; txn = txn.next) {
			txn.open = TRANSACTION_STATE.CLOSED;
		}
		for (let txn: DatabaseTransaction = this, next: DatabaseTransaction; txn; txn = next) {
			next = txn.next;
			txn.next = null;
			// Detach first so the abort() below performs only non-native cleanup, and so its doneReadTxn
			// loop cannot spin on a nulled handle. Not to avoid a double abort: rocksdb-js tolerates
			// abort-after-abort, and it is abort-after-COMMIT that throws.
			const detached =
				txn === this &&
				hasSiblingInFlight &&
				txn.transaction &&
				txn.transaction !== headTransaction &&
				(this.isActiveCommitHandle(txn.transaction) || hasDurableLog(txn.transaction))
					? null
					: txn.detachOwnedTransaction();
			const committingTransaction = txn === this ? headTransaction : detached;
			releaseTransactionLockHolds(committingTransaction);
			abortNativeTransaction(
				committingTransaction,
				'aborting conflicted transaction in chain after exhausting retries',
				txn.writes[0]?.store ?? txn.db,
				txn.startedFrom
			);
			// With outstanding iterators, the head owns a retained read handle while the retry commits
			// through a separate replay handle. Both must be aborted after retry exhaustion.
			if (txn === this && detached && detached !== committingTransaction) {
				abortNativeTransaction(
					detached,
					'aborting retained read transaction after exhausting retries',
					txn.writes[0]?.store ?? txn.db,
					txn.startedFrom
				);
			}
			try {
				// abort() synchronously walks savedBlobs and can call write.store.getEntry(), which can throw
				// (closed store, decode error). Catch and continue so one link's wrapper-cleanup failure can't
				// strand later links' native handles — they were already detached/aborted above regardless.
				txn.abort(false, false, committingTransaction);
			} catch (abortError) {
				harperLogger.debug?.('cleaning up conflicted transaction in chain after exhausting retries', abortError);
			}
		}
	}
	/**
	 * True if this transaction — or any database in its multi-store `next` chain — has writes accumulated
	 * that have not yet been committed. Writes to a second database live on `next` (see txnForContext), so a
	 * transaction that reads database A (head, tracked via its read snapshot, empty `writes`) and writes
	 * database B (`next`) must still count as write-bearing, or the monitor would misclassify it as read-only
	 * and force-commit B's writes via the commit cascade (issue #1407, multi-store path).
	 */
	hasPendingWrites(): boolean {
		for (let txn: DatabaseTransaction = this; txn; txn = txn.next) {
			for (let i = 0; i < txn.writes.length; i++) {
				if (txn.writes[i]) return true;
			}
		}
		return false;
	}
	/**
	 * Abort and poison this transaction (and its multi-store `next` chain) for `reason`, throwing on any
	 * further addWrite/commit (transactionOpenTooLongError / requestAbortedError) rather than the monitor
	 * force-committing a partial write set on the application's behalf (issue #1407) or a chain link
	 * silently committing on behalf of a request that was supposed to have been cut off (harper#2001).
	 * Poisons every link first, then aborts each — so a throw from one link's abort() can't leave a later
	 * link un-poisoned and eligible for a commit cascade to force-commit it or leak its native handle.
	 *
	 * A link whose native commit was submitted is past the point of no destructive return: poison it for
	 * everything that comes after, but let that attempt reach its outcome rather than racing cleanup
	 * against unknown durability. Accepted consequence: a submitted write can land after the client is gone.
	 *
	 * For a disconnect that point covers the whole chain: its unsubmitted links ride the cascade already
	 * under way, so the logical commit lands whole instead of splitting across stores (#1407). The monitor
	 * aborts them independently instead, because it only gets here for pre-commit work that outlived its grace.
	 */
	abortAndPoison(reason: 'timedOut' | 'disconnected'): void {
		const root = this.root ?? this;
		const submittedCommit = root.commitSubmitted && this.isChainCommitting();
		const spareWholeChain = submittedCommit && reason === 'disconnected';
		const links = new Set<DatabaseTransaction>();
		const collect = (start: DatabaseTransaction | undefined) => {
			for (let txn = start; txn; txn = txn.next) links.add(txn);
		};
		collect(root);
		collect(this);
		collect(root.submittedLink);
		if (root.submittedLinks) for (const txn of root.submittedLinks) collect(txn);
		for (const txn of links) {
			txn[reason] = true;
			if (spareWholeChain || (submittedCommit && txn.nativeCommitSubmitted)) txn.poisonedMidCommit = true;
			else {
				txn.poisonedMidCommit = false;
				txn.open = TRANSACTION_STATE.CLOSED;
			}
		}
		if (spareWholeChain) return;
		for (const txn of links) {
			if (submittedCommit && txn.nativeCommitSubmitted) continue;
			try {
				// An iterator's native cursor is owned by this transaction. Drop the staged writes now, but
				// leave its handle for doneReadTxn() so the iterator can finish without using a freed handle.
				// Abort only this link: a later link may already have submitted work whose outcome is unknown.
				txn.abort(true, false);
			} catch (error) {
				harperLogger.debug?.(`Error aborting ${reason} transaction in chain`, error);
			}
		}
	}
	/** The long-transaction monitor calls this when a write-bearing transaction stays open too long. */
	abortDueToTimeout(): void {
		this.abortAndPoison('timedOut');
	}
	/** A request this chain writes for was cancelled (admitRequestWrite, harper#2001). */
	abortDueToDisconnect(): void {
		this.abortAndPoison('disconnected');
	}

	/**
	 * Poison fresh ordinary work after a submitted commit stalls, without aborting any unknown native
	 * outcome. Start at the root so every still-attached link receives the poison; also cover a link an
	 * LMDB commit detached before its child settled.
	 */
	poisonAfterStalledSubmittedCommit(): void {
		const root = this.root ?? this;
		for (const txn of collectCommitLinks(root, this)) {
			txn.postSubmitPoisoned = true;
			// Not on a link an earlier poison already aborted: abort() cleared its write set, so excusing
			// its continuation from the poison check would let it resume onto nothing and report success.
			if (!txn.commitAttemptDoomedByPoison()) txn.poisonedMidCommit = true;
			if (txn.nativeCommitSubmitted) {
				txn.timedOut = true;
			}
		}
		root.timedOut = true;
	}
	directCommitSync(): void {
		const transaction = this.transaction;
		if (transaction) this.assertDatabaseCommitAllowed(transaction);
		try {
			transaction?.commitSync();
		} catch (error) {
			// Still uncommitted and still holding its write intents, and no caller aborts after this
			// throws. abort() rather than the native abort alone: it reclaims blobs a replayed write
			// staged.
			this.detachOwnedTransaction();
			abortNativeTransaction(
				transaction,
				'aborting a transaction whose synchronous commit failed',
				this.writes[0]?.store ?? this.db,
				this.startedFrom
			);
			try {
				this.abort();
			} catch (abortError) {
				harperLogger.debug?.('cleaning up after a failed synchronous commit', abortError);
			}
			throw error;
		}
		this.detachOwnedTransaction();
	}
	getContext() {
		return this.#context;
	}
	setContext(context) {
		this.#context = context;
	}
}
export interface CommitResolution {
	txnTime: number;
	next?: CommitResolution;
}
export interface Transaction {
	timeoutBudget?: number;
	commit(options): MaybePromise<CommitResolution>;
	abort?(): any;
}

export function shouldSpareCommitPhase(
	txn: DatabaseTransaction,
	checkedCommitPhaseChains: Set<DatabaseTransaction>
): boolean {
	if (!txn.committing) return false;
	if (txn.sourceApply || txn.isReplay) return true;
	const commitChainHead = txn.commitChainHead ?? txn;
	if (!checkedCommitPhaseChains.has(commitChainHead)) {
		checkedCommitPhaseChains.add(commitChainHead);
		commitChainHead.commitPhaseTicks++;
	}
	return commitChainHead.commitPhaseTicks <= COMMIT_PHASE_GRACE;
}

export class ImmediateTransaction extends DatabaseTransaction {
	isCommitting = false;
	saveCommits = true;
	constructor(db: RootDatabaseKind) {
		super();
		this.db = db;
	}
	save(...args: any[]): any {
		const operation = args[0]; // the staged write, not a transaction — commit() re-enters here with it
		if (operation?.deferSave) operation.deferSave = false;
		if (this.isCommitting || args[1] || args[3]) {
			// Stage into the transaction commit() is committing (on a retry round, the one being retried)
			// and reload within it; with no handle super.save() would open its own and nest a commit().
			super.save(operation, args[1], true, args[3]);
		} else {
			this.admitRequestWrite(); // a deferred save reaches here without passing through addWrite()
			this.isCommitting = true;
			// A synchronous throw from commit() (e.g. a 409 from an expired lock handle) would
			// otherwise leave isCommitting latched at true, causing every subsequent save() in this
			// context to take the fire-and-forget if-branch and silently drop writes.
			let commitResult: any;
			try {
				commitResult = this.commit();
			} catch (err) {
				this.isCommitting = false;
				throw err;
			}
			return when(
				commitResult,
				() => {
					this.isCommitting = false;
				},
				(err: any) => {
					// Async rejection (e.g. a rejected rocksdb commit promise) must also clear the
					// latch; without this, every subsequent save() silently fire-and-forgets.
					this.isCommitting = false;
					throw err;
				}
			);
		}
	}

	// Without an explicit transaction() a live lock is released only by unlock() or its lease, never
	// by the per-write commit. Expired handles are pruned so a reused context does not retain every key.
	releaseRecordLocks(): void {
		const recordLocks = this.recordLocks;
		if (!recordLocks) return;
		for (const [store, storeMap] of recordLocks) {
			for (const [keyId, handle] of storeMap) if (handle.released || handle.isExpired()) storeMap.delete(keyId);
			if (storeMap.size === 0) recordLocks.delete(store);
		}
		if (recordLocks.size === 0) this.recordLocks = undefined;
	}

	declare _timestamp: number;
	// @ts-expect-error accessor overriding property
	get timestamp() {
		return this._timestamp || (this._timestamp = getNextMonotonicTime());
	}
	set timestamp(value: number) {
		this._timestamp = value;
	}
	getReadTxn(): any {
		return; // no transaction means read latest
	}
}

/**
 * What `context.transaction` holds once its transaction has completed and released the back-reference
 * (see releaseContext()). `commit()`/`abort()` are no-ops and reads through it see the latest
 * committed state, so the documented `getContext().transaction.commit()` pattern stays callable after
 * completion, reporting the same `txnTime: 0` that re-committing the completed transaction itself did
 * (its own timestamp is reset by the commit that completed it).
 *
 * Not a DatabaseTransaction subclass and not extensible: one process-wide instance shared by every
 * released context owns no mutable state, and anything off this surface fails loudly rather than
 * inheriting behavior that would write through to every other context.
 */
const RELEASED_TRANSACTION_SURFACE = {
	open: TRANSACTION_STATE.CLOSED,
	transaction: undefined,
	writes: Object.freeze([]),
	commit(): CommitResolution {
		return { txnTime: 0 };
	},
	abort(): void {},
	getReadTxn(): undefined {
		return; // no transaction means read latest
	},
	useReadTxn(): undefined {
		return;
	},
	doneReadTxn(): void {},
	disregardReadTxn(): void {},
	hasPendingWrites(): boolean {
		return false;
	},
	addWrite(): never {
		throw new Error(
			'Cannot write to a transaction that has already completed; start a new one with transaction() or pass a fresh context'
		);
	},
	setContext(): never {
		throw new Error('Cannot attach a context to the shared released transaction');
	},
};
Object.freeze(RELEASED_TRANSACTION_SURFACE);
export const RELEASED_TRANSACTION = RELEASED_TRANSACTION_SURFACE as unknown as DatabaseTransaction;

/**
 * The placeholder means "this context has no transaction". Every reader that would otherwise act on the
 * value — claim it for a store, adopt it as a context, treat it as data — must ask first, or it operates
 * on the one instance every released context shares.
 */
export function isReleasedTransaction(value: unknown): boolean {
	return value === RELEASED_TRANSACTION;
}

/**
 * Whether this transaction can be joined as the atomic scope resources/transaction.ts promises. OPEN is
 * not sufficient: an ImmediateTransaction commits every write as it is made, so a caller that joined one
 * would get per-write autocommit with no final commit or abort to roll back to. txnForContext installs
 * one in a context slot that is empty or holds the released placeholder, where it reports OPEN with
 * nothing owning a commit for it (#2292). Ownership itself is deliberately not the test — a context
 * pre-seeded with an externally driven DatabaseTransaction (replayLogs.ts) still owns the writes it is
 * given, and its own commit/abort still governs them.
 */
export function isJoinableScope(transaction: DatabaseTransaction | null | undefined): boolean {
	return transaction?.open === TRANSACTION_STATE.OPEN && !transaction.saveCommits;
}

let timer;
let monitorTick = 0;

/**
 * True when a link other than `txn` in the same multi-store chain was written recently enough to
 * still be active — i.e. its `writeTimeout` (set only by addWrite, see the field comment) hasn't
 * decayed to zero. Writes re-arm only the link that receives them, so a chain writing database B
 * while its head only reads A would otherwise be aborted by the head's own decay.
 */
function chainStillActive(txn: DatabaseTransaction): boolean {
	for (let link: DatabaseTransaction = txn.next; link; link = link.next) {
		// A write-only link (e.g. a blind write to a second database, never itself read) never calls
		// getReadTxn, so it's never added to trackedTxns and the main loop below never decays it.
		// Decay it here instead, so an idle write-only link eventually expires rather than keeping the
		// whole chain immortal (harper#2001's blind-write shape).
		if (!trackedTxns.has(link) && link.writeTimeout > 0) link.writeTimeout -= txnExpiration;
		if (link.writeTimeout > 0) return true;
	}
	return false;
}

/**
 * Name a chain link still holding its native handle past the reporting threshold, and why the
 * branches below are not reaping it (harper#2471). Attribution only: it reads the recency clocks
 * those branches maintain rather than calling `chainStillActive`, which would decay `writeTimeout`
 * as a side effect, and it runs before them so it cannot reorder them.
 */
function reportLongLivedLink(
	link: DatabaseTransaction,
	thresholdMs: number,
	now: number,
	reportBudget: LongLivedHolderReportBudget
): void {
	if (!link.transaction || link.handleOpenedAt === 0) return;
	const ageMs = now - link.handleOpenedAt;
	if (ageMs < thresholdMs) return;
	const states: string[] = [];
	if (link.sourceApply) states.push('source-apply');
	if (link.isReplay) states.push('replay');
	if (link.committing) states.push('commit-phase');
	if (link.open === TRANSACTION_STATE.CLOSED) states.push('closed-with-open-iterators');
	if (monitorTick - link.writeTick <= 1) states.push('active');
	if (states.length === 0) states.push('over-limit');
	reportLongLivedHolder(
		{
			databasePath: (link.db as any)?.rootStore?.path,
			nativeId: link.transaction.id,
			openedAt: link.handleOpenedAt,
			ageMs,
			databaseName: (link.db as any)?.rootStore?.databaseName,
			tableName: (link.db as any)?.name,
			countPendingWrites: () => {
				let pendingWrites = 0;
				for (const write of link.writes) if (write) pendingWrites++;
				return pendingWrites;
			},
			states,
			timeoutBudget: link.timeoutBudget,
			startedFrom: link.startedFrom,
		},
		reportBudget
	);
}

/**
 * Report every link of this logical transaction that holds its own native handle. A blind write to a
 * second database attaches a handle to a `.next` link while only the root is supervised, so reporting
 * the entry alone names an id the sweep's line can never be joined to when the child is the holder.
 * Links that read are in `trackedTxns` and get their own visit from the tick.
 */
function reportIfLongLived(
	txn: DatabaseTransaction,
	thresholdMs: number,
	now: number,
	reportBudget: LongLivedHolderReportBudget
): void {
	if (thresholdMs === 0) return;
	for (let link: DatabaseTransaction = txn; link; link = link.next) {
		if (link !== txn && trackedTxns.has(link)) break;
		reportLongLivedLink(link, thresholdMs, now, reportBudget);
	}
}

/** Diagnostic grace after a native submission outlives the ordinary transaction timeout. */
const MAX_DEFERRED_POISON_TICKS = 2;
const STALLED_COMMIT_LOG_MIN_INTERVAL_MS = 1000;
// A logged retry parked on a write intent moves its retry counter at least every native park timeout,
// so a counter that has not moved for two of them is a native attempt that never settled — whatever
// the monitor's tick interval (STORAGE_MAXTRANSACTIONOPENTIME can be set far below the park timeout).
const configuredParkTimeoutMs = Number(process.env.ROCKSDB_JS_PARK_TIMEOUT_MS);
// Same acceptance rule as rocksdb-js: anything but a finite positive number falls back to its 5000 ms default.
const LOGGED_RETRY_STALL_MS =
	2 * (Number.isFinite(configuredParkTimeoutMs) && configuredParkTimeoutMs > 0 ? configuredParkTimeoutMs : 5000);
let lastStalledCommitWarningAt = -Infinity;
let lastStalledCommitErrorAt = -Infinity;

function submittedCommitStillInFlight(root: DatabaseTransaction): boolean {
	if (root.submittedLink?.nativeCommitSubmitted && root.submittedLink.commitsInFlight) return true;
	if (root.submittedLinks) {
		for (const txn of root.submittedLinks) {
			if (txn.nativeCommitSubmitted && txn.commitsInFlight) return true;
		}
	}
	return false;
}

// Every link the monitor would poison for a stalled commit, so the two walks agree on which links count.
function collectCommitLinks(root: DatabaseTransaction, txn: DatabaseTransaction): Set<DatabaseTransaction> {
	const links = new Set<DatabaseTransaction>();
	const collect = (start: DatabaseTransaction | undefined) => {
		for (let link = start; link; link = link.next) links.add(link);
	};
	collect(root);
	collect(txn);
	collect(root.submittedLink);
	if (root.submittedLinks) for (const link of root.submittedLinks) collect(link);
	return links;
}

function chainDurableLogRetries(root: DatabaseTransaction, txn: DatabaseTransaction): number {
	let retries = -1;
	for (const link of collectCommitLinks(root, txn)) {
		const linkRetries = link.activeDurableLogRetries();
		if (linkRetries >= 0) retries = Math.max(retries, 0) + linkRetries;
	}
	return retries;
}

/**
 * True when this tick must leave `txn` alone because some link has submitted writes whose native
 * outcome is not known yet. Merely entering commit() is not enough: a wholly pre-submit transaction
 * remains subject to shouldSpareCommitPhase() and its ordinary bounded grace.
 */
export function deferForCommitInFlight(
	txn: DatabaseTransaction,
	url: string | undefined,
	expiration = txnExpiration,
	tick = monitorTick
): boolean {
	const root = txn.root ?? txn;
	if (!txn.isChainCommitting() || !root.commitSubmitted) return false;
	// A sibling's submitted commit is protected by the links that own it. This one is poisoned and never
	// submitted, so deferring it only holds its retained snapshot for the diagnostic and commit-phase
	// graces on behalf of an attempt that is going to throw.
	if (txn.commitAttemptDoomedByPoison()) return false;
	// performance.now(), not Date.now(): a clock correction must not extend a stalled commit's hold on its
	// diagnostic grace, nor report a legitimately slow one early.
	const now = performance.now();
	const deadline = (root.deferredPoisonDeadline ??= now + MAX_DEFERRED_POISON_TICKS * expiration);
	// A handle with a durable log entry retrying a conflict has a known outcome — it commits once the
	// conflicting intent clears — so while its retry counter keeps advancing it is neither stalled nor
	// poisoned, and noteOverdueLoggedCommit is the operator's signal. A counter that has not moved for
	// LOGGED_RETRY_STALL_MS is a native attempt that never settled, which is the stall handled below.
	const loggedRetries = chainDurableLogRetries(root, txn);
	let loggedRetry = false;
	if (loggedRetries >= 0) {
		if (root.loggedRetriesTick === tick) {
			loggedRetry = Boolean(root.loggedRetryAdvancing);
		} else {
			if (root.loggedRetriesSeen !== loggedRetries) {
				root.loggedRetriesSeen = loggedRetries;
				root.loggedRetriesChangedAt = now;
			}
			loggedRetry = now - root.loggedRetriesChangedAt < LOGGED_RETRY_STALL_MS;
			root.loggedRetriesTick = tick;
			root.loggedRetryAdvancing = loggedRetry;
		}
	}
	let hasUnsubmittedCommit = false;
	let unsubmittedCommitGraceExpired = false;
	if (now >= deadline) {
		// Only reclaim after the commit has genuinely stalled. Submitted writes no longer depend on these
		// separate snapshots; pre-submit handles can still carry writes needed by the attempt.
		txn.releaseStalledCommitReadResources();
		if (!loggedRetry && !txn.isProtectedCommit()) {
			if (!root.postSubmitPoisoned) txn.poisonAfterStalledSubmittedCommit();
			for (const link of collectCommitLinks(root, txn)) {
				if (link.committing && !link.nativeCommitSubmitted) {
					hasUnsubmittedCommit = true;
					break;
				}
			}
			if (hasUnsubmittedCommit) {
				const unsubmittedDeadline = (root.unsubmittedCommitDeadline ??= now + COMMIT_PHASE_GRACE * expiration);
				if (now >= unsubmittedDeadline) {
					unsubmittedCommitGraceExpired = true;
					txn.abortDueToTimeout();
				}
			} else root.unsubmittedCommitDeadline = undefined;
		}
		if (
			!txn.nativeCommitSubmitted &&
			txn.open === TRANSACTION_STATE.CLOSED &&
			!(txn === root && submittedCommitStillInFlight(root))
		)
			return hasUnsubmittedCommit && !unsubmittedCommitGraceExpired;
		if (
			!loggedRetry &&
			!root.stalledCommitLogged &&
			now - lastStalledCommitErrorAt >= STALLED_COMMIT_LOG_MIN_INTERVAL_MS
		) {
			lastStalledCommitErrorAt = now;
			root.stalledCommitLogged = true;
			harperLogger.error(
				`A native commit has not settled after exceeding the open-transaction limit by a further ${
					MAX_DEFERRED_POISON_TICKS * expiration
				}ms. Its outcome is unknown, so Harper will not abort or delete its writes; fresh ordinary work ` +
					`on this transaction is rejected until it settles, and the worker may require a restart, from table: ${
						(txn.db as any)?.name + (url ? ' path: ' + url : '')
					}`
			);
		}
	} else if (!loggedRetry && now - lastStalledCommitWarningAt >= STALLED_COMMIT_LOG_MIN_INTERVAL_MS) {
		lastStalledCommitWarningAt = now;
		harperLogger.warn?.(
			`Transaction exceeded the open-transaction limit after submitting a native commit; preserving its unknown outcome, from table: ${
				(txn.db as any)?.name + (url ? ' path: ' + url : '')
			}`
		);
	}
	txn.timeout = Math.max(expiration, txn.timeoutBudget ?? 0);
	return true;
}

function startMonitoringTxns() {
	timer = setInterval(function () {
		monitorTick++;
		const checkedCommitPhaseChains = new Set<DatabaseTransaction>();
		const reportThresholdMs = getReportThresholdMs();
		rebaseLongLivedTransactionReports(reportThresholdMs);
		const reportBudget = createLongLivedHolderReportBudget(reportThresholdMs);
		const reportNow = performance.now();
		// Both registries, in sequence rather than as a union: a root can be in each (it read, and a
		// later link blind-wrote), and the membership check is cheaper than allocating per tick.
		for (const txn of trackedTxns)
			monitorTransaction(txn, checkedCommitPhaseChains, reportThresholdMs, reportNow, reportBudget);
		for (const txn of supervisedWriteRoots)
			if (!trackedTxns.has(txn))
				monitorTransaction(txn, checkedCommitPhaseChains, reportThresholdMs, reportNow, reportBudget);
		finishLongLivedHolderReports(reportBudget);
	}, txnExpiration).unref();

	function monitorTransaction(
		txn: DatabaseTransaction,
		checkedCommitPhaseChains: Set<DatabaseTransaction>,
		reportThresholdMs: number,
		reportNow: number,
		reportBudget: LongLivedHolderReportBudget
	) {
		if (txn.rangeReadActive) {
			txn.rangeReadActive = false;
			txn.renewReadTimeout();
		}
		reportIfLongLived(txn, reportThresholdMs, reportNow, reportBudget);
		{
			const commitChainHead = txn.commitChainHead ?? txn;
			// Decay write recency once per tick for every tracked link, independent of the `timeout`
			// branches below — a tracked link that keeps its own idle limit alive by reading must not
			// thereby keep chainStillActive believing it was written recently too.
			if (txn.writeTimeout > 0) txn.writeTimeout -= txnExpiration;
			if (txn.timeout <= 0) {
				const url = (txn.getContext() as any)?.url;
				if (deferForCommitInFlight(txn, url, txnExpiration)) return;
				if (
					txn.open === TRANSACTION_STATE.CLOSED &&
					!txn.commitAttemptDoomedByPoison() &&
					shouldSpareCommitPhase(txn, checkedCommitPhaseChains)
				) {
					harperLogger.warn?.(
						`Transaction has been in its commit phase past the open-transaction limit, waiting on pre-commit work; letting it complete, from table: ${
							(txn.db as any)?.name + (url ? ' path: ' + url : '')
						}`
					);
					txn.timeout = Math.max(txnExpiration, txn.timeoutBudget ?? 0);
					return;
				}
				if (txn.open === TRANSACTION_STATE.CLOSED) {
					if (!txn.transaction) {
						// Nothing left to supervise, and this is the registry's only unconditional exit:
						// membership otherwise ends when a claiming link detaches, which a chained commit
						// throwing synchronously inside when()'s success callback never reaches. Left
						// enrolled, the transaction would draw the warning below every tick forever.
						txn.dropWriteSupervision();
						return;
					}
					// Staged writes are not the monitor's to abort here: on the committed path they ride an
					// in-flight replay commit (see the outstanding-iterators branch in commit()) and dropping
					// them would re-introduce the silent write-loss-after-ack this structure prevents; on the
					// poisoned path abort(true) already discarded them. Only the snapshot's lifetime is left.
					// Close the owning iterators first so the handle comes back through doneReadTxn() — a
					// transaction poisoned outside transaction() has no callback settlement to do it.
					const closedIterators = txn.closeOwnedReadIterators();
					harperLogger.warn?.(
						`Read iterators held a ${
							txn.timedOut || txn.disconnected ? 'poisoned' : 'committed'
						} transaction's snapshot past the open-transaction limit; ${
							txn.transaction ? 'releasing it' : `closed ${closedIterators} abandoned iterator(s)`
						}, from table: ${(txn.db as any)?.name + (url ? ' path: ' + url : '')}`
					);
					if (txn.transaction) txn.releaseReadTxn();
				} else if (shouldSpareCommitPhase(txn, checkedCommitPhaseChains)) {
					// Parked in commit()'s pre-commit await — a `before`/`beforeIntermediate` hook, in practice a
					// blob's durable file write, which for a multi-tens-of-MB payload legitimately outruns the
					// limit. The write set is sealed and the caller is awaiting this commit, so the limit's
					// premise (the application is holding a transaction open) does not hold, and poisoning here
					// would unlink the blobs the write still references (issue #2062). The grace is bounded
					// because the transaction still pins a read snapshot: a source that stalls rather than
					// finishing falls through to the abort below once it runs out. A canonical-source apply or
					// replay is spared for as long as it takes: neither aborting it (harper-pro#348) nor the
					// force-commit below — which would durably commit a record whose blob file is still being
					// written — is acceptable, and their blob sources are bounded by the receive-side idle
					// watchdog instead.
					harperLogger.warn?.(
						`Transaction has been in its commit phase past the open-transaction limit, waiting on pre-commit work (e.g. a large blob write); letting it complete, from table: ${
							(txn.db as any)?.name + (url ? ' path: ' + url : '')
						}`,
						...(txn.startedFrom ? [`was started from ${txn.startedFrom.resourceName}.${txn.startedFrom.method}`] : [])
					);
					txn.timeout = Math.max(txnExpiration, txn.timeoutBudget ?? 0);
				} else if (txn.hasPendingWrites() && chainStillActive(txn)) {
					// A later link in the chain was written recently (writes re-arm only the link that
					// receives them, and a multi-store transaction can be writing database B while this
					// head only reads A). The logical transaction is still active, so re-arm this link
					// rather than aborting the whole chain out from under it.
					txn.timeout = Math.max(txnExpiration, txn.timeoutBudget ?? 0);
				} else if (txn.hasPendingWrites() && !txn.sourceApply && !txn.isReplay) {
					// Abort and surface an error rather than force-committing a partial write set: silently
					// committing on the application's behalf breaks atomicity and can leave orphaned
					// secondary-index entries that only a full index rebuild repairs (issue #1407). The app
					// owns long-running work (split into smaller transactions); core owns consistency.
					// Canonical-source applies (replication peer / external caching source) and crash-recovery
					// replay are excluded: they have no resubscribe/resume path, so aborting a write would drop
					// it while the resume cursor advances past it — a permanent divergence (harper-pro#348). For
					// those, keep the prior force-commit behavior below.
					harperLogger.status({ problem: 'database.txn-open-too-long', expires: 120 });
					harperLogger.error(
						`Transaction was open too long and has been aborted after exceeding the open-transaction limit, ` +
							describeCommitIdentity(txn.db, txn.startedFrom, txn.transaction) +
							(url ? ` path: ${url}` : ''),
						...(DEBUG_LONG_TXNS ? ['starting stack trace', txn.stackTraces] : [])
					);
					try {
						commitChainHead.abortDueToTimeout();
					} catch (error) {
						harperLogger.debug?.(`Error aborting timed out transaction: ${error.message}`);
					}
				} else {
					// Read-only long transaction (no atomicity/index risk — e.g. a large scan or export), or a
					// canonical-source apply/replay that must never drop a write: preserve the prior behavior of
					// committing to close out the snapshot without poisoning the transaction.
					let result: MaybePromise<CommitResolution>;
					try {
						result = txn.commit();
					} catch (error) {
						result = Promise.reject(error);
					}
					if ((result as any)?.then) {
						const monitorCommit = result as Promise<CommitResolution>;
						txn.monitorCommit = monitorCommit;
						monitorCommit.then(
							() => {
								if (txn.monitorCommit === monitorCommit) txn.monitorCommit = undefined;
							},
							(error) => {
								harperLogger.debug?.(`Error committing timed out transaction: ${error.message}`);
							}
						);
					}
					txn.timeout = Math.max(txnExpiration, txn.timeoutBudget ?? 0);
				}
			} else {
				txn.timeout -= txnExpiration;
			}
		}
	}
}

startMonitoringTxns();

/**
 * Test seam: re-arms the once-per-process replay warning. The whole unit suite shares one process,
 * so whichever test first drives a commit under open iterators consumes the warning for every test
 * after it.
 */
export function resetReplayedWritesWarning() {
	replayedWritesWarned = false;
}

export function setMaxOutstandingTxnDuration(ms: number): number {
	const previous = MAX_OUTSTANDING_TXN_DURATION;
	MAX_OUTSTANDING_TXN_DURATION = ms;
	return previous;
}

/** Test seam: overrides the per-retry backoff cap and returns the previous value. */
export function setMaxRetryDelayMs(ms: number): number {
	const previous = MAX_RETRY_DELAY_MS;
	MAX_RETRY_DELAY_MS = ms;
	return previous;
}

/** Test seam: whether the monitor supervises this logical transaction for its writes. */
export function isWriteSupervised(txn: DatabaseTransaction): boolean {
	return supervisedWriteRoots.has(txn);
}

/** Test seam: returns the current open-transaction monitor interval. */
export function getTxnExpiration(): number {
	return txnExpiration;
}

export function setTxnExpiration(ms) {
	clearInterval(timer);
	txnExpiration = ms;
	startMonitoringTxns();
	return trackedTxns;
}
