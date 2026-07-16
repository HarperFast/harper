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
	LINGERING: 2, // the transaction has completed a read, but can be used for immediate writes
};
const MAX_RETRIES = 40;
// Cap the per-retry backoff so replication-applied transactions, which retry conflicts without a
// cap (see the commit rejection handler), don't grow the delay unbounded.
const MAX_RETRY_DELAY_MS = 1000;
let outstandingCommit, outstandingCommitStart;
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

// ── Commit-settlement watchdog (issue #1785) ─────────────────────────────────────────────────────
// Under heavy CPU throttling (cgroup CFS quotas — CPU-limited containers, macOS App Nap), two
// distinct async-delivery links in the commit path were observed to be silently severed: the
// native commit's completion callback (commit succeeded and durable, but the JS promise never
// settled), and the retry-backoff timer (delay scheduled, never fired). Either loss orphans the
// caller's commit promise forever: no error, no timeout, an ingest pipeline wedged indefinitely.
// The upstream primitive has not been isolated (bare timers/threadpool under identical throttle
// never lose wakeups), so the invariant is enforced externally: every native commit/abort
// resolution and every retry backoff settles within bounded time, whichever internal link dies.
// A single lazy, unref'd interval sweeps both registries; interval loss self-heals on later ticks.

// Deadline for a native commit/abort resolution to settle. Derived from the queue-admission
// threshold: anything past 2× that is far outside a plausible in-flight commit and indicates a
// lost completion rather than a slow one.
let commitSettleTimeout = 2 * MAX_OUTSTANDING_TXN_DURATION;
const WATCHDOG_SWEEP_INTERVAL = 5000;
// A backoff timer this far past due is treated as lost and fired by the sweeper instead.
const BACKOFF_RECOVERY_GRACE = 2000;
const SOURCE_APPLY_OVERDUE_LOG_INTERVAL = 60_000;

type CommitWatch = {
	kind: 'commit' | 'abort';
	start: number;
	nativeTxn: RocksTransaction | null;
	dbTxn: DatabaseTransaction | null;
	resolve: (value?: number | void) => void;
	reject: (error: Error) => void;
	lastOverdueLog: number;
};

// When the sweeper recovers an entry whose native promise never settles, that promise's reaction
// closures still capture the entry forever; null the heavy refs so a lost completion does not
// permanently retain the transaction's write batch and native handle.
function releaseWatch(watch: CommitWatch) {
	watch.nativeTxn = null;
	watch.dbTxn = null;
}
type BackoffWatch = {
	due: number;
	fire: (recovered: boolean) => void;
};
const commitWatches = new Set<CommitWatch>();
const backoffWatches = new Set<BackoffWatch>();
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function ensureWatchdogTimer() {
	if (!watchdogTimer) watchdogTimer = setInterval(sweepCommitWatchdog, WATCHDOG_SWEEP_INTERVAL).unref();
}
function maybeStopWatchdogTimer() {
	if (watchdogTimer && commitWatches.size === 0 && backoffWatches.size === 0) {
		clearInterval(watchdogTimer);
		watchdogTimer = null;
	}
}

/**
 * Wraps a native commit/abort resolution so it is guaranteed to settle. The wrapper passes the
 * native outcome through untouched (including the RETRY_NOW_VALUE sentinel); if the native
 * completion is never delivered, the sweeper settles the wrapper at the deadline instead.
 * Exported for unit tests.
 */
export function watchCommitSettlement<T>(
	resolution: Promise<T> | void,
	nativeTxn: RocksTransaction,
	dbTxn: DatabaseTransaction,
	kind: 'commit' | 'abort'
): Promise<T> | void {
	if (!(resolution as any)?.then) return resolution as void;
	return new Promise<T>((resolve, reject) => {
		const watch: CommitWatch = {
			kind,
			start: performance.now(),
			nativeTxn,
			dbTxn,
			resolve: resolve as CommitWatch['resolve'],
			reject,
			lastOverdueLog: -Infinity,
		};
		commitWatches.add(watch);
		ensureWatchdogTimer();
		// Set.delete as the once-guard: whichever of the real settle or the sweeper recovery runs
		// first removes the entry; the loser sees delete() return false and does nothing.
		(resolution as Promise<T>).then(
			(value) => {
				if (commitWatches.delete(watch)) {
					maybeStopWatchdogTimer();
					resolve(value);
				}
			},
			(error) => {
				if (commitWatches.delete(watch)) {
					maybeStopWatchdogTimer();
					reject(error);
				}
			}
		);
	});
}

/**
 * A retry backoff whose continuation survives a lost timer: the sweeper fires any entry overdue
 * past the grace window, with a once-guard so the late real timer no-ops. Exported for unit tests.
 */
export function robustBackoff<T>(ms: number, resume: () => MaybePromise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const watch: BackoffWatch = {
			due: performance.now() + ms,
			fire(recovered: boolean) {
				if (!backoffWatches.delete(watch)) return;
				clearTimeout(timer);
				maybeStopWatchdogTimer();
				if (recovered) {
					harperLogger.error(
						`Commit retry backoff timer (${ms}ms) was lost and recovered by the settlement watchdog (issue #1785)`
					);
				}
				try {
					resolve(resume());
				} catch (error) {
					reject(error);
				}
			},
		};
		const timer = setTimeout(() => watch.fire(false), ms);
		backoffWatches.add(watch);
		ensureWatchdogTimer();
	});
}

/**
 * Sweeps both watchdog registries. `now` is injectable for tests; exported for tests.
 */
export function sweepCommitWatchdog(now = performance.now()) {
	for (const watch of backoffWatches) {
		if (now > watch.due + BACKOFF_RECOVERY_GRACE) watch.fire(true);
	}
	for (const watch of commitWatches) {
		const age = now - watch.start;
		// Insertion-ordered Set + monotonic start times: entries after the first still-young one are
		// younger still. Retained sourceApply lingerers are older than the deadline, so they never
		// trigger this break — they fall through to their keep-waiting branch below.
		if (age < commitSettleTimeout) break;
		// Feature-detected terminal outcome from rocksdb-js (future getter; absent in 2.4.x). When
		// present, the lost completion is replayed exactly; when absent, only a lost abort is safe
		// to adjudicate (an abort's loss cannot affect durability).
		const outcome = (watch.nativeTxn as any)?.outcome;
		if (watch.kind === 'abort' || outcome === 'committed') {
			commitWatches.delete(watch);
			harperLogger.error(
				`Native ${watch.kind} completion was never delivered (${Math.round(age)}ms); recovered as ${
					watch.kind === 'abort' ? 'aborted' : 'committed'
				} by the settlement watchdog (issue #1785)`
			);
			watch.resolve(undefined);
			releaseWatch(watch);
		} else if (outcome === 'retry-now') {
			commitWatches.delete(watch);
			harperLogger.error(
				`Native commit RETRY_NOW completion was never delivered (${Math.round(age)}ms); recovered by the settlement watchdog (issue #1785)`
			);
			watch.resolve(RETRY_NOW_VALUE);
			releaseWatch(watch);
		} else if (watch.dbTxn?.sourceApply) {
			// A source-applied write must never be dropped (no resubscribe/resume path — rejecting an
			// indeterminate outcome could permanently diverge the node), so keep waiting and surface
			// rate-limited visibility instead.
			if (now - watch.lastOverdueLog > SOURCE_APPLY_OVERDUE_LOG_INTERVAL) {
				watch.lastOverdueLog = now;
				harperLogger.error(
					`Source-apply commit settlement is ${Math.round(age)}ms overdue and its outcome is unknown; retaining (never-drop invariant, issue #1785)`
				);
			}
			continue;
		} else {
			commitWatches.delete(watch);
			harperLogger.error(
				`Commit settlement timed out after ${Math.round(age)}ms with unknown outcome; rejecting (issue #1785)`
			);
			watch.reject(
				new ServerError(
					`Commit did not settle within ${commitSettleTimeout}ms and its outcome is unknown: the write may or may not be durable. Verify before retrying non-idempotent operations`,
					503
				)
			);
			releaseWatch(watch);
		}
	}
	maybeStopWatchdogTimer();
}

/** Test hook, following the setTxnExpiration precedent. Returns the previous value. */
export function setCommitSettleTimeout(ms: number): number {
	const previous = commitSettleTimeout;
	commitSettleTimeout = ms;
	return previous;
}

/** Test hook: registry sizes, for asserting cleanup. */
export function getCommitWatchdogCounts() {
	return { commits: commitWatches.size, backoffs: backoffWatches.size };
}
// ── end commit-settlement watchdog ───────────────────────────────────────────────────────────────

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
};

type RocksTransactionWithRetry = RocksTransaction & { isRetry?: boolean };

export class DatabaseTransaction implements Transaction {
	#context: Context;
	writes: TransactionWrite[] = []; // the set of writes to commit if the conditions are met
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
		if (DEBUG_LONG_TXNS) {
			this.stackTraces = [new StartedTransaction()];
		}
		if ((this.transaction as any).openTimer) (this.transaction as any).openTimer = 0;
		trackedTxns.add(this);
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
			trackedTxns.delete(this);
			if (this.open === TRANSACTION_STATE.LINGERING) {
				// if we have lingering writes, we have to call commit to finish them
				this.commit();
			} else {
				this.transaction?.abort();
				this.transaction = null;
			}
		}
	}

	disregardReadTxn(): void {
		if (--this.readTxnRefCount === 0 && this.readTxnsUsed === 1) {
			this.doneReadTxn();
		}
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
		transaction ??= this.transaction;
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
		// Sticky record that THIS write staged with its audit entry appended (log entries are written
		// at staging and are not part of the transaction, so they survive an abort). isRetry stagings
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
		let transaction = options.transaction ?? this.transaction; // we need to preserve this transaction as we might to resurrect it if we have to retry
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
				if (--this.readTxnsUsed > 0) {
					// we still have outstanding iterators using the transaction, we can't just commit/abort it, we will still
					// need to use it
					if (this.writes.length > 0) {
						// if there are outstanding writes, we have to call commit later to finish them
						this.open = TRANSACTION_STATE.LINGERING;
						/* TODO: This is not really the intended behavior though, we want to immediately commit writes, but continue to use
						 * the transaction, as there is likely existing references to the transaction in other parts of the codebase,
						 * particularly in the query iterator */
					}
					/*
				commitResolution =
					this.writes.length > 0
						? transaction?.commit({ renewAfterCommit: true }) // Try to use RocksDB's CommitAndTryCreateSnapshot
			: // don't abort, we still have outstanding reads to complete
							null;
				*/
				} else {
					// no more reads need to be performed, just commit/abort based if there are any writes
					trackedTxns.delete(this);
					this.transaction = null; // clear transaction so any further operations operate immediately
					if (transaction) {
						this.writes = this.writes.filter((write) => write); // filter out removed entries
						if (this.writes.length > 0) {
							// The transaction was created with coordinatedRetry:true (see
							// getReadTxn), so commit() can resolve to RETRY_NOW_VALUE.
							// That sentinel is handled in the resolve callback below and the
							// cast to Promise<void> is safe — the sentinel never propagates
							// past that branch. The settlement watch guarantees the resolution
							// settles even if the native completion is lost (issue #1785).
							commitResolution = watchCommitSettlement(
								transaction.commit() as Promise<void>,
								transaction,
								this,
								'commit'
							);
						} else {
							try {
								commitResolution = watchCommitSettlement(transaction.abort(), transaction, this, 'abort');
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
										// release the native transaction before giving up so the throw does
										// not leak its handle (mirrors the ERR_BUSY cap path)
										try {
											transaction.abort();
										} catch (abortError) {
											harperLogger.debug?.('aborting conflicted transaction after exhausting retries', abortError);
										}
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
								completions.push(this.next.commit(options));
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
							this.writes = [];
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
								if (error.code === 'ERR_TRY_AGAIN') {
									// ERR_BUSY recovers on recommit: the save loop re-writes each key, re-tracking it at
									// the current sequence, so validation passes once the contention clears. ERR_TRY_AGAIN
									// never does: the memtable history validation needs is gone (flushed during a
									// bulk-ingest burst), and recommitting re-checks the same stranded snapshot, so it
									// fails forever even on an idle database. A source-apply transaction's uncapped retry
									// then spins for good and wedges the replication apply loop at its commit await,
									// freezing every leg of that database on the node. Replay onto a fresh transaction
									// instead: the save loop reloads each entry through it and re-resolves against
									// current state. Carry over the commit hook the transaction-log store attached
									// (aftercommit emit / structure watermarks; it reads its state off the original
									// transaction object, which abort() leaves intact); the retry-site isRetry stamp
									// below keeps the log entries themselves from being re-added.
									const retryTransaction: RocksTransactionWithRetry = new RocksTransaction(
										(this.writes.find((write) => write)?.store.store ?? this.db.store) as RocksStore
									);
									if (this.timestamp) retryTransaction.setTimestamp(this.timestamp);
									(retryTransaction as any).onCommit = (transaction as any).onCommit;
									try {
										transaction.abort();
									} catch (abortError) {
										// usually already released by the failed commit; log for the unexpected case
										harperLogger.debug?.('aborting stranded transaction after failed commit', abortError);
									}
									transaction = retryTransaction;
								}
								// Mark the native transaction as a retry so RocksTransactionLogStore skips re-staging entries.
								// Stamp AFTER the possible ERR_TRY_AGAIN swap above so the fresh replay transaction is
								// marked too; otherwise it would re-stage audit/change-feed log entries on recommit.
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
											// giving up: release the current transaction (original or the fresh replay above)
											// so the throw does not leak its native handle
											try {
												transaction.abort();
											} catch (abortError) {
												harperLogger.debug?.('aborting conflicted transaction after exhausting retries', abortError);
											}
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
									// start delaying, back off to try to space out transactions and avoid excessive conflicts.
									// robustBackoff rather than a bare delay: a lost timer here orphans the commit forever (issue #1785)
									return robustBackoff(Math.min(this.retries * this.retries, MAX_RETRY_DELAY_MS), () =>
										this.commit({ ...options, transaction })
									);
								}
								return this.commit({ ...options, transaction }); // try again
							} else throw error;
						}
					);
				}
				for (const write of this.writes) {
					if (write?.skipped && write?.savedBlobs)
						cleanupUnusedBlobs(write.savedBlobs, collectRetainedFileIds(write.store.getEntry(write.key)?.value));
				}
				this.writes = [];
				if (this.#context?.resourceCache) this.#context.resourceCache = null;
				const txnResolution: CommitResolution = {
					txnTime: this.timestamp,
				};
				if (this.next) {
					// now run any other transactions
					options.timestamp = this.timestamp;
					const nextResolution = this.next?.commit(options);
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
		this.writes = [];
		if (this.#context?.resourceCache) this.#context.resourceCache = null;
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
			// Force the CLOSED path when releasing the read snapshot: doneReadTxn() flushes lingering writes via
			// commit() while open === LINGERING, and commit() now throws transactionOpenTooLongError once poisoned.
			// Closing first makes the release discard (abort) the uncommitted writes instead, which is the intent.
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
				if (txn.hasPendingWrites() && !txn.sourceApply && !txn.isReplay) {
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
