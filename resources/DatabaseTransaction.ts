import { cleanupUnusedBlobs, collectRetainedFileIds } from './blob.ts';
import { Transaction as LMDBTransaction } from 'lmdb';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility.ts';
import { ServerError } from '../utility/errors/hdbError.ts';
import * as harperLogger from '../utility/logging/harper_logger.ts';
import type { Context, Id } from './ResourceInterface.ts';
import * as envMngr from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { convertToMS } from '../utility/common_utils.ts';
import { when } from '../utility/when.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { Transaction as RocksTransaction, type Store as RocksStore, constants } from '@harperfast/rocksdb-js';
const RETRY_NOW_VALUE = constants.RETRY_NOW_VALUE;
import type { RootDatabaseKind } from './databases.ts';
import type { Entry } from './RecordEncoder.ts';
import { toBufferKey } from 'ordered-binary';

const trackedTxns = new Set<DatabaseTransaction>();
const MAX_OUTSTANDING_TXN_DURATION = convertToMS(envMngr.get(CONFIG_PARAMS.STORAGE_MAXTRANSACTIONQUEUETIME)) || 45000; // Allow write transactions to be queued for up to 45 seconds before we start rejecting them
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
// Cap the per-retry backoff so replication-applied transactions, which retry conflicts without a
// cap (see the commit rejection handler), don't grow the delay unbounded.
const MAX_RETRY_DELAY_MS = 1000;
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
	// Identity for the one-time checkOverloaded() log below (harper#2001) — otherwise a stuck commit
	// gives no indication of which database/table/resource to investigate. Snapshotted at arm time
	// (not read from `this.writes`/`this.startedFrom` lazily off the DatabaseTransaction object)
	// because that object can be reused for a later immediate commit while this native commit is
	// still wedged — its resolve handler runs clearWrites() on the SAME object, which would blank or
	// replace the identity out from under a deferred read. Per-node (not a single module-level slot)
	// so that every outstanding commit carries its own identity and its own `logged` flag: a second
	// commit that is still stuck once the first settles becomes the new oldest and logs on its own.
	store: any;
	startedFrom: { resourceName: string; method: string } | undefined;
	nativeTransaction: any;
	logged: boolean;
}
let oldestOutstandingCommit: OutstandingCommit | undefined;
let newestOutstandingCommit: OutstandingCommit | undefined;
let outstandingCommitCount = 0;
// Caps the stuck-commit log (checkOverloaded() below) to at most one line per this interval across
// the whole thread, regardless of how many distinct commits individually cross the threshold — see
// the comment at the log site for why a per-commit-only dedup isn't enough under sustained overload.
const OVERLOAD_LOG_MIN_INTERVAL_MS = 1000;
let lastOverloadLogAt = -Infinity;

// Track a submitted commit until it settles. Every attempt is tracked unconditionally: a
// coordinated retry round and a chained second-store commit are both issued from inside the
// preceding commit's own resolve handler, which runs before any reaction that could release a
// single shared slot — so anything conditional on "is something already outstanding" skips them
// and leaves a wedged retry or chain invisible to checkOverloaded() forever. Each attempt is timed
// from its own submission, keeping the overload window per-attempt rather than cumulative over a
// retry ladder. `.then(untrack, untrack)` also marks an ERR_BUSY rejection handled, so this
// tracking never surfaces as an unhandled rejection alongside the caller's own handler.
// Exported only so unit tests can drive the list with controllable promises: the unlink order that
// matters (a middle or tail node settling first) cannot be forced through real writes, and a node
// left linked would 503 every write on this thread forever. commit() below is the sole caller.
// Also the single source for write-queue-depth accounting (getTransactionQueueDepths below): every
// native commit this function tracks is, by definition, exactly the write-queue backlog — see the
// comment there for why that used to be a second, separately-maintained counter.
// `store`/`startedFrom`/`nativeTransaction` are the identity snapshot for checkOverloaded()'s stuck-
// commit log (harper#2001); omit them (as the test seam below does) when a caller has none to give.
export function trackOutstandingCommit(
	commitResolution: Promise<number | void>,
	store?: any,
	startedFrom?: { resourceName: string; method: string },
	nativeTransaction?: any
): void {
	// Guards against a future caller passing a non-Promise: today commit() always hands this a real
	// Promise, but an unguarded link here would leave a node permanently wedged in the list (503ing
	// every write on this thread) with no settlement to ever unlink it.
	if (typeof commitResolution?.then !== 'function') return;
	const outstanding: OutstandingCommit = {
		start: performance.now(),
		prev: newestOutstandingCommit,
		next: undefined,
		store,
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

let confirmReplication;
export function replicationConfirmation(callback) {
	confirmReplication = callback;
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

type MaybePromise<T> = T | Promise<T>;

export type CommitOptions = {
	doneWriting?: boolean;
	timestamp?: number;
	retries?: number;
	flush?: boolean;
	transaction?: RocksTransaction;
};

type ReadTransaction = (LMDBTransaction | RocksTransaction) & {
	openTimer?: number;
	retryRisk?: number;
	isDone?: boolean;
	isCommitted?: boolean;
};

export type TransactionWrite = {
	key: Id;
	store: any; // using any here because of circular dependency and complex RootDatabaseKind
	invalidated?: boolean;
	entry?: Partial<Entry>;
	before?: () => void | Promise<void>;
	beforeIntermediate?: () => void | Promise<void>;
	commit?: (txnTime: number, existingEntry: Partial<Entry>, retry: boolean, transaction: any) => MaybePromise<void>;
	validate?: (txnTime: number) => void;
	fullUpdate?: boolean;
	saved?: boolean;
	deferSave?: boolean;
	skipReplicationConfirmation?: boolean;
	nodeName?: string;
	nodeId?: number;
	promise?: Promise<any>;
	result?: any;
	// blobs that were pre-saved as part of this write; used to clean up files if the commit is skipped or aborted
	savedBlobs?: Blob[];
	// the commit handler's most recent decision: true means it took an early-return that left savedBlobs unreferenced.
	// reset at the top of each commit-handler invocation so retries see a fresh state.
	skipped?: boolean;
	// sticky: a non-isRetry staging of this write appended its audit entry (set in save(); the retry
	// dedup guards in the commit handler read it to ignore the write's own orphaned entry)
	appendedAuditEntry?: boolean;
	// the preceding write to the same store and key in this transaction, if any (linked in addWrite)
	priorWrite?: TransactionWrite;
	// what this write left for its key in this transaction, once its commit handler stored it (a
	// deletion stages an entry with no value). Reset at the top of each commit-handler invocation so
	// a retry round that takes an early return doesn't leave the prior round's state behind.
	stagedEntry?: Partial<Entry>;
	// a later write to the same key in this transaction replaced (or deleted) the record this write
	// stored, so blobs this write saved are only reachable through its audit entry. Reset per
	// commit-handler round, like stagedEntry.
	superseded?: boolean;
	// this write appended an audit entry, which references its saved blobs — they then belong to the
	// audit trail (audit pruning deletes them), so the superseded-write cleanup must leave them alone
	blobsAuditReferenced?: boolean;
};

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

type RocksTransactionWithRetry = RocksTransaction & { isRetry?: boolean };

export class DatabaseTransaction implements Transaction {
	#context: Context;
	writes: TransactionWrite[] = []; // the set of writes to commit if the conditions are met
	// the last staged write per store and key, used to chain repeat writes to the same key (linkWrite)
	declare writesByKey?: Map<any, Map<unknown, TransactionWrite>>;
	completions: Promise<void>[] = []; // the set of outstanding async operations to complete
	db: RootDatabaseKind;
	transaction: RocksTransactionWithRetry;
	readTxn: ReadTransaction;
	readTxnRefCount: number;
	readTxnsUsed: number;
	timeout: number;
	// Write recency, tracked separately from `timeout`: set only by addWrite, never by a read. `timeout`
	// is re-armed by reads too (on a link with no pending writes of its own, see the fast path in
	// getReadTxn), so chainStillActive can't use it to mean "this link was written recently" — a `.next`
	// link with no writes that is being read in a loop would otherwise masquerade as write activity and
	// keep a write-holding head immortal.
	declare writeTimeout: number;
	timeoutBudget = 0;
	validated = 0;
	timestamp = 0;
	retries = 0;
	declare next: DatabaseTransaction;
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
	// Set once the retained read handle's write intents have been released (see commit()'s
	// outstanding-iterators branch), so a retry round cannot re-fire the release.
	declare writesAbandoned?: boolean;

	getReadTxn(disableSnapshot?: boolean): ReadTransaction {
		this.readTxnRefCount = (this.readTxnRefCount || 0) + 1;
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
		this.transaction = new RocksTransaction(this.db.store, { coordinatedRetry: true, disableSnapshot });

		if (this.timestamp) {
			this.transaction.setTimestamp(this.timestamp);
		}

		this.readTxnsUsed = 1;
		this.baseReadRefConsumed = false; // fresh handle, fresh base reference for commit() to consume
		if (DEBUG_LONG_TXNS) {
			this.stackTraces = [new StartedTransaction()];
		}
		if ((this.transaction as any).openTimer) (this.transaction as any).openTimer = 0;
		trackedTxns.add(this);
		if (trackedTxns.size > readTxnQueueDepthHighWater) readTxnQueueDepthHighWater = trackedTxns.size;
		return this.transaction;
	}

	useReadTxn(disableSnapshot?: boolean) {
		const readTxn = this.getReadTxn(disableSnapshot);
		if (DEBUG_LONG_TXNS) this.stackTraces.push(new StartedTransaction());
		this.readTxnsUsed++;
		return readTxn;
	}

	doneReadTxn() {
		if (!this.transaction) return;
		if (--this.readTxnsUsed === 0) {
			// The native handle was only being held open for the read iterators: any writes staged
			// through it were already committed at commit() time by replaying them onto a fresh
			// transaction (see the outstanding-iterators branch in commit()), so aborting it here
			// discards nothing — the replay re-staged the writes AND their audit/txn-log entries
			// into its own transaction; this handle's never-committed log batch dies with it.
			trackedTxns.delete(this);
			this.transaction?.abort();
			this.transaction = null;
			this.completeDeferredContextRelease();
		}
	}

	/**
	 * Force-release the retained native read handle without touching staged writes. Used by the
	 * long-transaction monitor for a CLOSED (already-acknowledged) transaction whose iterators have
	 * held the read snapshot past the open-transaction limit: the writes are not the monitor's to
	 * abort (an in-flight replay commit owns them), only the snapshot's lifetime is enforced.
	 */
	releaseReadTxn(): void {
		trackedTxns.delete(this);
		this.readTxnsUsed = 0; // doneReadTxn() no-ops for the remaining iterators (guarded on this.transaction)
		try {
			this.transaction?.abort();
		} catch (error) {
			harperLogger.debug?.('releasing timed-out read transaction', error);
		}
		this.transaction = null;
		this.completeDeferredContextRelease();
	}

	/**
	 * Complete a context release that releaseContext() deferred because outstanding read iterators
	 * were still using this transaction (see releaseContext()) — called once the last one drains,
	 * whether that happens naturally (doneReadTxn()) or is forced by the long-transaction monitor
	 * (releaseReadTxn()).
	 */
	private completeDeferredContextRelease(): void {
		if (!this.pendingContextRelease) return;
		this.pendingContextRelease = false;
		if (this.#context?.transaction === this) this.#context.transaction = null;
	}

	disregardReadTxn(): void {
		if (--this.readTxnRefCount === 0 && this.readTxnsUsed === 1) {
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
		const keyId = writeKeyId(operation.key);
		const priorWrite = writesForStore.get(keyId);
		if (priorWrite) operation.priorWrite = priorWrite;
		writesForStore.set(keyId, operation);
	}

	/**
	 * Discard the staged write set (committed or aborted); the per-key chain must go with it so a
	 * reused transaction never bases a write on a previous batch's staged state.
	 */
	clearWrites(): void {
		this.writes = [];
		this.writesByKey = undefined;
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
	 * Sets `.transaction` to `null` rather than deleting the property: `Context.transaction` is
	 * typed `DatabaseTransaction | null | undefined` precisely to document this released state, and
	 * `delete` would repeatedly force a long-lived, hot context (e.g. an MQTT subscription context
	 * releasing/reattaching a transaction per message) into V8's slower dictionary-mode property
	 * storage.
	 */
	private releaseContext(final: boolean): void {
		if (!final) return;
		if (this.readTxnsUsed > 0) {
			this.pendingContextRelease = true;
			return;
		}
		if (this.#context?.transaction === this) this.#context.transaction = null;
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
			if (!oldestOutstandingCommit.logged && now - lastOverloadLogAt > OVERLOAD_LOG_MIN_INTERVAL_MS) {
				// Log once per stuck commit (not once per rejected request, harper#2001): a wedged
				// thread otherwise logs nothing at all server-side while rejecting every write with a
				// 503, which was the single biggest obstacle to root-causing a recurrence. The flag lives
				// on the node itself, so if THIS commit settles while still over the limit and a
				// different one is now oldest, that one logs too instead of staying silent forever.
				oldestOutstandingCommit.logged = true;
				lastOverloadLogAt = now;
				const nativeTransactionId = oldestOutstandingCommit.nativeTransaction?.id;
				const store = oldestOutstandingCommit.store;
				const startedFrom = oldestOutstandingCommit.startedFrom;
				harperLogger.error(
					`Rejecting writes on this thread: a commit has been outstanding for ` +
						`${Math.round(now - oldestOutstandingCommit.start)}ms (exceeds the ` +
						`${MAX_OUTSTANDING_TXN_DURATION}ms limit), from table: ${store?.rootStore?.databaseName ?? '?'}.${store?.name ?? '?'}` +
						(nativeTransactionId !== undefined ? ` (transaction ${nativeTransactionId})` : '') +
						(startedFrom?.resourceName
							? `, started from ${startedFrom.resourceName}${startedFrom.method ? '.' + startedFrom.method : ''}`
							: '') +
						`. Further record updates and publishes from new application requests on this thread ` +
						`will be rejected with 503 until the commit settles or the process is restarted (deletes, ` +
						`and writes applied from a canonical source, e.g. replication or a caching source, bypass this check).`
				);
			}
			throw new ServerError('Outstanding write transactions have too long of queue, please try again later', 503);
		}
		this.overloadChecked = true; // only check this once, don't interrupt ongoing transactions that have already made writes
	}

	/**
	 * The stored entry of the last write eligible for replication confirmation. Two kinds of write are
	 * skipped (rather than ending the search) so a trailing one cannot suppress confirmation for
	 * replicable writes staged earlier: writes that explicitly opt out (audit-only markers, which stage
	 * no record), and writes with no stored entry at all — a delete, or a delete on an `audit: false`
	 * table, leaves nothing to read back. So a `put(A); delete(B)` transaction confirms on A's entry,
	 * whose version is this transaction's (every write in a transaction is stamped with one version).
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
	stageCompletion(completion: Promise<void>) {
		completion.then(undefined, () => {});
		this.completions.push(completion);
	}

	/**
	 * Discard staged completions that no commit() will ever aggregate (abort path). Their rejections
	 * are already no-op-handled by stageCompletion(), so without this they fail silently; log instead.
	 * Clearing them also keeps a reused transaction's next commit() from rejecting with the previous
	 * batch's error.
	 */
	drainCompletions(): void {
		if (this.completions.length === 0) return;
		const completions = this.completions;
		this.completions = [];
		for (const completion of completions)
			completion.then(undefined, (error) =>
				harperLogger.warn?.('A staged transaction completion failed after the transaction was aborted', error)
			);
	}

	addWrite(operation: TransactionWrite) {
		if (this.timedOut) throw transactionOpenTooLongError();
		// A write is activity: it re-arms the idle limit on this link even though the reads it
		// performs no longer do (see getReadTxn), so a transaction that keeps writing stays alive
		// and only an idle one holding write intents is reaped.
		this.timeout = Math.max(txnExpiration, this.timeoutBudget ?? 0);
		// Independent write-recency signal for chainStillActive (see the field comment) — reads never
		// touch this, only writes do.
		this.writeTimeout = this.timeout;
		this.linkWrite(operation);
		this.writes.push(operation);
		if (!operation.deferSave) {
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
		let txnTime = this.timestamp;
		// Only an OPEN transaction accepts new staged writes. After commit, this.transaction may still
		// be retained for outstanding read iterators; staging into it would silently discard the write
		// when doneReadTxn() aborts the handle, so such writes commit immediately on a fresh
		// transaction below instead.
		if (!transaction && this.open === TRANSACTION_STATE.OPEN) transaction = this.transaction;
		let immediateCommit = false;
		if (!transaction) {
			transaction = new RocksTransaction(operation.store.store as RocksStore);
			if (operation.store.rootStore !== this.db.rootStore) {
				harperLogger.warn?.('Created new transaction in save, but the store does match existing store', transaction.id);
			}
			if (this.open === TRANSACTION_STATE.OPEN) {
				this.transaction = transaction;
			} else {
				// if it is closed, we have to immediately commit, using our immediate transaction
				immediateCommit = true;
			}
			if (txnTime) {
				transaction.setTimestamp(txnTime);
			}
		}
		if (this.isReplay) {
			// Replayed writes came FROM the transaction log; never re-append them —
			// replay iterates that same log, so re-appending prevents convergence
			// (boot hangs replaying its own output). Conflict retries stamp isRetry
			// at the retry sites in commit(); this is the replay-path equivalent.
			(transaction as RocksTransactionWithRetry).isRetry = true;
		}
		if (!txnTime) txnTime = this.timestamp = transaction.getTimestamp();
		if (reloadEntry || operation.entry === undefined) {
			operation.entry = operation.store.getEntry(operation.key, { transaction });
		}
		if (!operation.saved) {
			operation.saved = true;
			// immediately execute in this transaction
			if ((operation.validate?.(txnTime) as any) === false) {
				operation.commit = () => {}; // noop if we try again
				return;
			}
			let result: Promise<void> = operation.before?.() as Promise<void>;
			if (result?.then) this.stageCompletion(result);
			result = operation.beforeIntermediate?.() as Promise<void>;
			if (result?.then) this.stageCompletion(result);
		}
		const completion = operation.commit(txnTime, operation.entry, this.retries > 0, transaction) as Promise<void>;
		if (typeof completion?.then === 'function') this.stageCompletion(completion);
		// Sticky record that THIS write staged with its audit entry appended (log entries batch on the
		// native transaction and are durably written by its commit attempt — even a failed one — so
		// they survive the abort-after-failed-commit of the retry paths). isRetry stagings
		// skip the log write, so they never set it. The retry dedup guards in the commit handler key
		// off this: a launderable proxy (like last attempt's skipped state) breaks under multi-round
		// retries where a recommit round self-skips before a fresh-transaction replay.
		if (!operation.skipped && !(transaction as RocksTransactionWithRetry).isRetry) {
			operation.appendedAuditEntry = true;
		}
		if (immediateCommit) {
			return this.commit({ ...options, transaction }); // immediately commit if the harper transaction is closed
		}
	}

	/**
	 * Resolves with information on the timestamp and success of the commit
	 */
	commit(options: CommitOptions = {}): MaybePromise<CommitResolution> {
		if (this.timedOut) throw transactionOpenTooLongError();
		// reused across retries — the native layer resets it in place (fresh snapshot) on IsBusy/TryAgain —
		// but reassigned to a fresh replay transaction when outstanding read iterators retain this.transaction
		let transaction = options.transaction ?? this.transaction;
		for (let i = 0; i < this.writes.length; i++) {
			let operation = this.writes[i];
			if (!operation || (this.retries === 0 && operation.saved)) continue;
			this.save(operation, transaction, i < this.validated, options);
		}
		this.validated = this.writes.length;
		const completions = this.completions;
		if (completions.length > 0) this.completions = []; // reset
		return when(
			completions.length > 0 ? Promise.all(completions) : null,
			() => {
				if (this.writes.length > this.validated) {
					// check just in case we got any more transactions while we were waiting, if so just recursively continue to finish the additional writes now
					return this.commit(options);
				}
				this.open = TRANSACTION_STATE.CLOSED;
				// RocksTransaction.commit() resolves with RETRY_NOW_VALUE (a number) under
				// coordinatedRetry, or void on a normal commit/abort.
				let commitResolution: Promise<number | void> | void;
				// Consume this commit's own read reference — exactly once per read handle: retry
				// recursions, immediate-commit re-entries, and a second top-level commit() (wrapper
				// commit after an explicit in-handler commit) must not steal a reference owned by an
				// outstanding iterator (doneReadTxn() would then never release the native handle).
				if (!this.baseReadRefConsumed) {
					this.baseReadRefConsumed = true;
					this.readTxnsUsed--;
				}
				if (this.readTxnsUsed > 0) {
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
					if (this.writes.length > 0) {
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
							this.retries++; // a replay round: commit handlers re-base on the reloaded entries
							for (const operation of this.writes) {
								this.save(operation, replayTransaction, true, options);
							}
							transaction = replayTransaction;
						}
						// with options.transaction set this is a retry round — the save loop above already
						// re-staged the writes into it
						commitResolution = transaction.commit() as Promise<void>;
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
					if (!this.writesAbandoned) {
						this.writesAbandoned = true;
						try {
							(this.transaction as { abandonWrites?: () => void } | null)?.abandonWrites?.();
						} catch (error) {
							harperLogger.warn?.('Failed to release write intents on a retained read transaction', error);
						}
					}
				} else {
					// no more reads need to be performed, just commit/abort based if there are any writes
					trackedTxns.delete(this);
					this.transaction = null; // clear transaction so any further operations operate immediately
					if (transaction) {
						this.writes = this.writes.filter((write) => write); // filter out removed entries
						if (this.writes.length > 0) {
							// The transaction was created with coordinatedRetry:true (see
							// getReadTxn), so commit() can resolve to RETRY_NOW_VALUE. That
							// sentinel (a number) is why commitResolution is typed
							// Promise<number | void>; it is handled in the resolve callback below.
							commitResolution = transaction.commit();
							// Record how long this commit stays outstanding (submit → settle) as a distribution
							// metric. This is the same clock the overload check uses (trackOutstandingCommit
							// stamps each attempt at submit), so a rising p99/p999 is the leading indicator for the
							// "Outstanding write transactions have too long of queue" (503) rejection. A transient-
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
							try {
								commitResolution = transaction.abort();
							} catch {
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
					trackOutstandingCommit(commitResolution, this.writes[0]?.store, this.startedFrom, transaction);
					const completions = [];
					return commitResolution.then(
						(commitResult) => {
							if (commitResult === RETRY_NOW_VALUE) {
								this.retries++;
								harperLogger.debug?.('coordinated retry', transaction.id, this.retries);
								// Mark this specific native transaction as a retry so RocksTransactionLogStore
								// skips re-writing its already-staged txn-log entries (#2).
								(transaction as RocksTransactionWithRetry).isRetry = true;
								// Mirror the ERR_BUSY cap/warn policy: non-sourceApply transactions abort
								// at MAX_RETRIES; sourceApply transactions keep retrying with periodic warn.
								if (this.retries > MAX_RETRIES) {
									if (!this.sourceApply) {
										// giving up: poison and abort the whole linked chain so no link leaks its native
										// handle / read snapshot — or any unpublished transaction-log position — until GC.
										this.abortChainAfterRetries(transaction);
										throw new ServerError(
											`After ${MAX_RETRIES} coordinated retries, unable to commit transaction, transaction is in conflict with ongoing writes`
										);
									}
									if (this.retries % MAX_RETRIES === 0) {
										harperLogger.warn?.(
											`Source-applied transaction ${transaction.id} still in conflict after ${this.retries} coordinated retries; continuing to retry`
										);
									}
								}
								return this.commit({ ...options, transaction });
							}
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
							if (this.next) {
								// never forward options.transaction (a retry/replay round's HEAD-store handle) to
								// the next store — it must commit its own writes through its own transaction
								completions.push(
									this.next.commit(options.transaction ? { ...options, transaction: undefined } : options)
								);
							}
							if (options?.flush) {
								completions.push(this.writes[0].store.flushed);
							}
							if (this.replicatedConfirmation) {
								// if we want to wait for replication confirmation, we need to track the transaction times
								// and when replication notifications come in, we count the number of confirms until we reach the desired number
								const databaseName = this.writes[0].store.rootStore.databaseName;
								const lastEntry = this.lastConfirmableEntry();
								if (confirmReplication && lastEntry) {
									completions.push(
										confirmReplication(databaseName, (lastEntry as any).version, this.replicatedConfirmation)
									);
								}
							}
							// commit succeeded; clean up files for any writes whose commit-handler took an early-return,
							// or whose stored record a later write to the same key replaced without an audit entry
							// keeping its blobs reachable (checked against the final committed record, so a blob the
							// later write retained survives). Deferred until here so a retry that *would* have
							// referenced the blob can flip skipped/superseded back to false first.
							for (const write of this.writes) {
								if (write?.savedBlobs && (write.skipped || (write.superseded && !write.blobsAuditReferenced)))
									cleanupUnusedBlobs(write.savedBlobs, collectRetainedFileIds(write.store.getEntry(write.key)?.value));
							}
							// now reset transactions tracking; this transaction be reused and committed again
							this.retries = 0; // reset per-native-transaction retry counter so a reused DatabaseTransaction's next batch starts fresh
							this.clearWrites();
							this.releaseContext(!!options.doneWriting);
							this.next = null;
							let txnTime = this.timestamp;
							this.timestamp = 0; // reset the timestamp as well
							return Promise.all(completions).then(() => {
								return {
									txnTime,
								};
							});
						},
						(error) => {
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
								this.retries++;
								harperLogger.debug?.('retrying', transaction.id, this.retries);
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
								(transaction as RocksTransactionWithRetry).isRetry = true;
								if (this.retries > 2) {
									// Transactions applying data from a canonical source of truth (replication peer or
									// external caching source) must never drop a write on a transient conflict: there is no
									// re-subscribe / sequence-id-resume path, so a dropped write would leave this node
									// permanently diverged (harper-pro#348). Such transactions retry without a cap; the source
									// apply loop serializes commits (backpressure), so contention clears rather than
									// compounding. Request-path transactions keep the MAX_RETRIES cap and surface a loud error.
									const neverDropOnConflict = this.sourceApply;
									if (this.retries > MAX_RETRIES) {
										if (!neverDropOnConflict) {
											// giving up: poison and abort the whole linked chain so no link leaks its native
											// handle / read snapshot until GC.
											this.abortChainAfterRetries(transaction);
											throw new ServerError(
												`After ${MAX_RETRIES} retries, unable to commit transaction, transaction is in conflict with ongoing writes`
											);
										}
										// Uncapped retry can otherwise stall silently (debug logging is off in production);
										// surface periodic visibility into a stalled source-apply commit.
										if (this.retries % MAX_RETRIES === 0) {
											harperLogger.warn?.(
												`Source-applied transaction ${transaction.id} still in conflict after ${this.retries} retries; continuing to retry`
											);
										}
									}
									// start delaying, back off to try to space out transactions and avoid excessive conflicts
									return delay(Math.min(this.retries * this.retries, MAX_RETRY_DELAY_MS)).then(() =>
										this.commit({ ...options, transaction })
									);
								}
								return this.commit({ ...options, transaction }); // try again
							} else {
								// terminal (non-conflict) failure: release the native handle so it doesn't leak;
								// usually already released by the failed commit itself, abort for the unexpected
								// case (same defensive pattern as the retry-exhaustion give-up above)
								try {
									transaction.abort();
								} catch (abortError) {
									harperLogger.debug?.('aborting transaction after failed commit', abortError);
								}
								// A terminal failure is just as final as a success — release the context's
								// back-reference here too, or transaction.ts's onComplete() (which has no
								// rejection handler of its own) would leave a long-lived context pinning this
								// CLOSED wrapper forever.
								this.releaseContext(!!options.doneWriting);
								throw error;
							}
						}
					);
				}
				for (const write of this.writes) {
					if (write?.savedBlobs && (write.skipped || (write.superseded && !write.blobsAuditReferenced)))
						cleanupUnusedBlobs(write.savedBlobs, collectRetainedFileIds(write.store.getEntry(write.key)?.value));
				}
				this.clearWrites();
				this.releaseContext(!!options.doneWriting);
				const txnResolution: CommitResolution = {
					txnTime: this.timestamp,
				};
				if (this.next) {
					// now run any other transactions
					options.timestamp = this.timestamp;
					// as above: the next store must not inherit this store's explicit native transaction
					const nextResolution = this.next?.commit(
						options.transaction ? { ...options, transaction: undefined } : options
					);
					if ((nextResolution as any)?.then)
						return (nextResolution as any)?.then((nextResolution) => ({
							txnTime: this.timestamp,
							next: nextResolution,
						}));
					txnResolution.next = nextResolution as any;
				}
				return txnResolution;
			},
			(error) => {
				this.abort();
				throw error;
			}
		);
	}
	abort(): void {
		while (this.readTxnsUsed > 0) this.doneReadTxn(); // release the read snapshot when we abort, we assume we don't need it
		// A write-only transaction never took a read reference (getReadTxn was never called), so the loop
		// above releases nothing even though save() created a native handle; release it here instead of
		// leaking the handle and its snapshot until GC. abortDueToTimeout() detaches the handle before
		// calling abort(), so this is a no-op there rather than a double-abort.
		if (this.transaction) this.releaseReadTxn();
		this.open = TRANSACTION_STATE.CLOSED;
		this.drainCompletions();
		for (const write of this.writes) {
			if (write?.savedBlobs)
				cleanupUnusedBlobs(write.savedBlobs, collectRetainedFileIds(write.store.getEntry(write.key)?.value));
		}
		// reset the transaction
		this.clearWrites();
		// A timeout-poisoned abort (abortDueToTimeout()) is the one abort that is NOT "reuse-free":
		// Resource.ts's dispatcher deliberately keeps joining a `timedOut` transaction (instead of
		// starting a fresh one) so the rest of the logical operation fails atomically via the
		// poison check in addWrite()/commit(), rather than silently landing a later write on a
		// brand-new transaction after an earlier one was rolled back (#1411). Releasing here would
		// make that check see `undefined?.timedOut` and take the "start fresh" branch instead.
		this.releaseContext(!this.timedOut);
	}
	/**
	 * Give up on a chain of linked transactions after exhausting conflict retries: poison every link
	 * first, then abort each link's native transaction and release its DatabaseTransaction-level
	 * resources. Two passes (mirroring abortDueToTimeout) so a throw while aborting one link can't leave
	 * later links (this.next) holding native handles / read snapshots until GC. `headTransaction` is the
	 * head link's native transaction, which commit() detached to a local before this point
	 * (this.transaction is already null), so it is aborted directly; every other link still owns its
	 * native transaction on `txn.transaction`.
	 */
	abortChainAfterRetries(headTransaction: RocksTransaction): void {
		for (let txn: DatabaseTransaction = this; txn; txn = txn.next) {
			txn.open = TRANSACTION_STATE.CLOSED;
		}
		for (let txn: DatabaseTransaction = this; txn; txn = txn.next) {
			const nativeTxn = txn === this ? headTransaction : txn.transaction;
			// Clear the native handle and read-snapshot bookkeeping so the abort() below only performs
			// non-native cleanup (blobs, writes) and can't double-abort (RocksTransaction.abort() throws
			// on an already-aborted handle) or spin abort()'s doneReadTxn loop on a nulled handle.
			txn.transaction = null;
			txn.readTxnsUsed = 0;
			trackedTxns.delete(txn);
			try {
				nativeTxn?.abort();
			} catch (abortError) {
				harperLogger.debug?.('aborting conflicted transaction in chain after exhausting retries', abortError);
			}
			try {
				// abort() synchronously walks savedBlobs and can call write.store.getEntry(), which can throw
				// (closed store, decode error). Catch and continue so one link's wrapper-cleanup failure can't
				// strand later links' native handles — they were already detached/aborted above regardless.
				txn.abort();
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
			if (txn.writes.some((write) => write)) return true;
		}
		return false;
	}
	/**
	 * Abort and poison this transaction because it exceeded the open-transaction limit. The next write or
	 * commit throws transactionOpenTooLongError so the request fails cleanly and rolls back, rather than the
	 * monitor force-committing a partial write set on the application's behalf (issue #1407). The whole
	 * multi-store `next` chain is poisoned and aborted: writes to a second database live on `next`, so
	 * leaving it un-poisoned would let the head's commit cascade force-commit them (or orphan its resources
	 * until it self-times-out).
	 */
	abortDueToTimeout(): void {
		// Poison every link first, then abort each, so a throw from one link's abort() can't leave later links
		// in the chain un-poisoned (and thus eligible to be force-committed by a later commit cascade).
		for (let txn: DatabaseTransaction = this; txn; txn = txn.next) {
			txn.timedOut = true;
			txn.open = TRANSACTION_STATE.CLOSED;
		}
		for (let txn: DatabaseTransaction = this; txn; txn = txn.next) {
			try {
				txn.abort();
			} catch (error) {
				harperLogger.debug?.(`Error aborting timed-out transaction in chain: ${error.message}`);
			}
		}
	}
	directCommitSync(): void {
		trackedTxns.delete(this);
		this.transaction?.commitSync();
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

export class ImmediateTransaction extends DatabaseTransaction {
	isCommitting = false;
	constructor(db: RootDatabaseKind) {
		super();
		this.db = db;
	}
	save(...args: any[]): any {
		const transaction = args[0];
		if (this.isCommitting) {
			// if we are in the commit, do the save and force a reload so we get a read within the transaction
			super.save(transaction, null as any, true);
		} else {
			this.isCommitting = true;
			return when(this.commit(), () => {
				this.isCommitting = false;
			});
		}
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

let timer;

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

function startMonitoringTxns() {
	timer = setInterval(function () {
		for (const txn of trackedTxns) {
			// Decay write recency once per tick for every tracked link, independent of the `timeout`
			// branches below — a tracked link that keeps its own idle limit alive by reading must not
			// thereby keep chainStillActive believing it was written recently too.
			if (txn.writeTimeout > 0) txn.writeTimeout -= txnExpiration;
			if (txn.timeout <= 0) {
				const url = (txn.getContext() as any)?.url;
				if (txn.open === TRANSACTION_STATE.CLOSED) {
					// The commit was already acknowledged; any staged writes are riding an in-flight
					// replay commit (see the outstanding-iterators branch in commit()) and are not the
					// monitor's to abort — dropping them here would re-introduce the silent
					// write-loss-after-ack this branch structure exists to prevent. Only the read
					// snapshot's lifetime is left to enforce: release the retained native handle that
					// the overdue iterators are holding open.
					harperLogger.warn?.(
						`Read iterators held a committed transaction's snapshot past the open-transaction limit; releasing it, from table: ${
							(txn.db as any)?.name + (url ? ' path: ' + url : '')
						}`
					);
					txn.releaseReadTxn();
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
					harperLogger.error(
						`Transaction was open too long and has been aborted after exceeding the open-transaction limit, from table: ${
							(txn.db as any)?.name + (url ? ' path: ' + url : '')
						}`,
						...(txn.startedFrom ? [`was started from ${txn.startedFrom.resourceName}.${txn.startedFrom.method}`] : []),
						...(DEBUG_LONG_TXNS ? ['starting stack trace', txn.stackTraces] : [])
					);
					try {
						txn.abortDueToTimeout();
					} catch (error) {
						harperLogger.debug?.(`Error aborting timed out transaction: ${error.message}`);
					}
				} else {
					// Read-only long transaction (no atomicity/index risk — e.g. a large scan or export), or a
					// canonical-source apply/replay that must never drop a write: preserve the prior behavior of
					// committing to close out the snapshot without poisoning the transaction.
					try {
						const result = txn.commit();
						if ((result as any)?.then) {
							(result as any).catch((error) => {
								harperLogger.debug?.(`Error committing timed out transaction: ${error.message}`);
							});
						}
					} catch (error) {
						harperLogger.debug?.(`Error committing timed out transaction: ${error.message}`);
					}
					txn.timeout = Math.max(txnExpiration, txn.timeoutBudget ?? 0);
				}
			} else {
				txn.timeout -= txnExpiration;
			}
		}
	}, txnExpiration).unref();
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

export function setTxnExpiration(ms) {
	clearInterval(timer);
	txnExpiration = ms;
	startMonitoringTxns();
	return trackedTxns;
}
