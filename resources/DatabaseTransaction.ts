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

const trackedTxns = new Set<DatabaseTransaction>();
const MAX_OUTSTANDING_TXN_DURATION = convertToMS(envMngr.get(CONFIG_PARAMS.STORAGE_MAXTRANSACTIONQUEUETIME)) || 45000; // Allow write transactions to be queued for up to 25 seconds before we start rejecting them
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
let outstandingCommit, outstandingCommitStart;

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
// `writeTxnQueueDepth` counts write commits handed to the storage engine but not yet resolved —
// this is the backlog that, when it drains too slowly, produces the "Outstanding write transactions
// have too long of queue" overload error. Read depth is derived from the live `trackedTxns` set
// (every tracked transaction holds an open read snapshot). We also retain a high-water mark per
// sampling window because the queue can fill and drain within a single (~1s) analytics period, so an
// instantaneous sample taken at emit time would routinely miss the spike operators need to see.
// RocksDB-write-path only: LMDB routes through the separate LMDBTransaction.commit()/getReadTxn()
// overrides (resources/LMDBTransaction.ts), which maintain their own unrelated `trackedTxns` set and
// do not call into this accounting.
let writeTxnQueueDepth = 0;
let writeTxnQueueDepthHighWater = 0;
let readTxnQueueDepthHighWater = 0;

function enterWriteQueue() {
	if (++writeTxnQueueDepth > writeTxnQueueDepthHighWater) writeTxnQueueDepthHighWater = writeTxnQueueDepth;
}
function leaveWriteQueue() {
	// Floor at zero: accounting is balanced by construction (every enterWriteQueue has exactly one
	// matching settlement), but the guard is cheap insurance against a future call-site imbalance
	// producing a negative depth that would corrupt every subsequent sample.
	if (writeTxnQueueDepth > 0) writeTxnQueueDepth--;
}

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
		writeDepth: writeTxnQueueDepth,
		writeMaxDepth: writeTxnQueueDepthHighWater,
		readDepth,
		readMaxDepth: readTxnQueueDepthHighWater,
	};
	writeTxnQueueDepthHighWater = writeTxnQueueDepth;
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
		'Transaction was aborted after exceeding the open-transaction limit; split long-running work into smaller transactions',
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
	commit?: (txnTime: number, existingEntry: Partial<Entry>, retry: boolean, transaction: any) => void;
	validate?: (txnTime: number) => void;
	fullUpdate?: boolean;
	saved?: boolean;
	deferSave?: boolean;
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
};

/**
 * The state a preceding write in this transaction left for `operation`'s key, or undefined if this
 * is the first write to it. Within a transaction the writes are ordered by program order, and
 * neither storage engine can serve that state to a read — LMDB applies staged writes only in the
 * commit batch — so a later write to the same key gets its basis from the write that staged it
 * rather than from a pre-transaction read (harper#1968). Walks past writes that staged nothing
 * (a skipped or non-record write) to the last one that did.
 */
export function priorStagedEntry(operation: TransactionWrite): Partial<Entry> | undefined {
	for (let prior = operation.priorWrite; prior; prior = prior.priorWrite) {
		if (prior.stagedEntry) return prior.stagedEntry;
	}
}

/**
 * Key identity for the per-key write chain. A Map already distinguishes primitive types, so a
 * numeric key indexes it as-is (no allocation on the write path); string and composite (array) keys
 * go through JSON, whose encodings can never collide with each other ("a" vs ["a"]) or with a
 * number.
 */
function writeKeyId(key: Id): unknown {
	return typeof key === 'number' ? key : JSON.stringify(key);
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
	validated = 0;
	timestamp = 0;
	retries = 0;
	declare next: DatabaseTransaction;
	declare stale: boolean;
	// Whether this read handle's base reference (readTxnsUsed starts at 1 in getReadTxn) has been
	// consumed by a commit round; iterator references are consumed only by doneReadTxn().
	declare baseReadRefConsumed?: boolean;
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

	getReadTxn(disableSnapshot?: boolean): ReadTransaction {
		this.readTxnRefCount = (this.readTxnRefCount || 0) + 1;
		this.timeout = txnExpiration; // reset the timeout
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
	}

	disregardReadTxn(): void {
		if (--this.readTxnRefCount === 0 && this.readTxnsUsed === 1) {
			this.doneReadTxn();
		}
	}

	/**
	 * Chain a newly staged write to the preceding write to the same store and key, so its commit
	 * handler can apply on top of what that write staged instead of the pre-transaction record
	 * (see priorStagedEntry). Called by both engines' addWrite.
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

	checkOverloaded() {
		if (
			outstandingCommit &&
			!this.overloadChecked &&
			performance.now() - outstandingCommitStart > MAX_OUTSTANDING_TXN_DURATION
		) {
			throw new ServerError('Outstanding write transactions have too long of queue, please try again later', 503);
		}
		this.overloadChecked = true; // only check this once, don't interrupt ongoing transactions that have already made writes
	}

	addWrite(operation: TransactionWrite) {
		if (this.timedOut) throw transactionOpenTooLongError();
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
			if (result?.then) this.completions.push(result);
			result = operation.beforeIntermediate?.() as Promise<void>;
			if (result?.then) this.completions.push(result);
		}
		operation.commit(txnTime, operation.entry, this.retries > 0, transaction);
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
							// metric. This is the same clock the overload check uses (outstandingCommitStart is
							// stamped at submit), so a rising p99/p999 is the leading indicator for the
							// "Outstanding write transactions have too long of queue" (503) rejection. A transient-
							// conflict retry rejects this promise and issues a fresh commit(), and outstandingCommit
							// re-arms per attempt, so recording per attempt matches the overload semantics.
							// commitResolution's declared type (Promise<number | void> | void) doesn't narrow to
							// Promise<void> here because the widening union defeats flow analysis on the prior
							// cast assignment; re-assert it — this branch's commit() result is always a Promise.
							recordCommitLatency(commitResolution as Promise<void>, performance.now());
							// Count this commit against the write queue depth until the storage engine
							// resolves it. A transient-conflict retry rejects this promise and issues a
							// fresh commit() (re-entering here), so the enter/leave stays balanced. leaveWriteQueue
							// never throws, so the settled promise resolves and needs no rejection handling of its own.
							// The thenable guard protects against a future caller passing a non-Promise
							// `commitResolution` (today it is always rocksdb-js's async Transaction.commit()
							// result, guaranteed to be a Promise).
							enterWriteQueue();
							if (commitResolution && typeof (commitResolution as any).then === 'function') {
								commitResolution.then(leaveWriteQueue, leaveWriteQueue);
							} else {
								leaveWriteQueue();
							}
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
					if (!outstandingCommit) {
						outstandingCommit = commitResolution;
						outstandingCommitStart = performance.now();
						outstandingCommit
							// if `commitResolution` rejects with and `ERR_BUSY` error, the retry logic
							// will correct course, but the reject will still be propagated on the
							// `outstandingCommit` promise and needs to be caught and silenced
							.catch(() => {})
							.finally(() => {
								outstandingCommit = null;
							});
					}
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
								const lastWrite = this.writes[this.writes.length - 1];
								if (confirmReplication && lastWrite) {
									completions.push(
										confirmReplication(
											databaseName,
											(lastWrite.store.getEntry(lastWrite.key) as any).version,
											this.replicatedConfirmation
										)
									);
								}
							}
							// commit succeeded; clean up files for any writes whose commit-handler took an early-return.
							// deferred until here so a retry that *would* have referenced the blob can flip skipped back to false first.
							for (const write of this.writes) {
								if (write?.skipped && write?.savedBlobs)
									cleanupUnusedBlobs(write.savedBlobs, collectRetainedFileIds(write.store.getEntry(write.key)?.value));
							}
							// now reset transactions tracking; this transaction be reused and committed again
							this.retries = 0; // reset per-native-transaction retry counter so a reused DatabaseTransaction's next batch starts fresh
							this.clearWrites();
							if (this.#context?.resourceCache) this.#context.resourceCache = null;
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
								throw error;
							}
						}
					);
				}
				for (const write of this.writes) {
					if (write?.skipped && write?.savedBlobs)
						cleanupUnusedBlobs(write.savedBlobs, collectRetainedFileIds(write.store.getEntry(write.key)?.value));
				}
				this.clearWrites();
				if (this.#context?.resourceCache) this.#context.resourceCache = null;
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
		this.open = TRANSACTION_STATE.CLOSED;
		for (const write of this.writes) {
			if (write?.savedBlobs)
				cleanupUnusedBlobs(write.savedBlobs, collectRetainedFileIds(write.store.getEntry(write.key)?.value));
		}
		// reset the transaction
		this.clearWrites();
		if (this.#context?.resourceCache) this.#context.resourceCache = null;
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

function startMonitoringTxns() {
	timer = setInterval(function () {
		for (const txn of trackedTxns) {
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
					txn.timeout = txnExpiration;
				}
			} else {
				txn.timeout -= txnExpiration;
			}
		}
	}, txnExpiration).unref();
}

startMonitoringTxns();

export function setTxnExpiration(ms) {
	clearInterval(timer);
	txnExpiration = ms;
	startMonitoringTxns();
	return trackedTxns;
}
