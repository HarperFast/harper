import { Transaction as LMDBTransaction } from 'lmdb';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility.js';
import { ServerError } from '../utility/errors/hdbError.js';
import * as harperLogger from '../utility/logging/harper_logger.js';
import type { Context, Id } from './ResourceInterface.ts';
import * as envMngr from '../utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { convertToMS } from '../utility/common_utils.js';
import { when } from '../utility/when.ts';
import { Transaction as RocksTransaction, type Store as RocksStore } from '@harperfast/rocksdb-js';
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
let outstandingCommit, outstandingCommitStart;
let confirmReplication;
export function replicationConfirmation(callback) {
	confirmReplication = callback;
}
let txnExpiration = envMngr.get(CONFIG_PARAMS.STORAGE_MAXTRANSACTIONOPENTIME) ?? 30000;

class StartedTransaction extends Error {}

type MaybePromise<T> = T | Promise<T>;

export type CommitOptions = {
	doneWriting?: boolean;
	timestamp?: number;
	retries?: number;
	flush?: boolean;
};

type ReadTransaction = (LMDBTransaction | RocksTransaction) & {
	openTimer?: number;
	retryRisk?: number;
};

export type TransactionWrite = {
	key: Id;
	store: RootDatabaseKind;
	invalidated?: boolean;
	entry?: Partial<Entry>;
	before?: () => void | Promise<void>;
	beforeIntermediate?: () => void | Promise<void>;
	commit?: (txnTime: number, existingEntry: Entry, retry: boolean, transaction: RocksTransaction) => void;
	validate?: (txnTime: number) => void;
	fullUpdate?: boolean;
	saved?: boolean;
	deferSave?: boolean;
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

	getReadTxn(): ReadTransaction {
		this.readTxnRefCount = (this.readTxnRefCount || 0) + 1;
		this.timeout = txnExpiration; // reset the timeout
		if (this.transaction) {
			if (this.transaction.openTimer) this.transaction.openTimer = 0;
			return this.transaction;
		}
		if (this.open !== TRANSACTION_STATE.OPEN) return; // can not start a new read transaction as there is no future commit that will take place, just have to allow the read to latest database state

		this.transaction = new RocksTransaction(this.db.store);
		if (this.timestamp) {
			this.transaction.setTimestamp(this.timestamp);
		}

		this.readTxnsUsed = 1;
		if (DEBUG_LONG_TXNS) {
			this.stackTraces = [new StartedTransaction()];
		}
		if (this.transaction.openTimer) this.transaction.openTimer = 0;
		trackedTxns.add(this);
		return this.transaction;
	}

	useReadTxn() {
		const readTxn = this.getReadTxn();
		if (DEBUG_LONG_TXNS) this.stackTraces.push(new StartedTransaction());
		this.readTxnsUsed++;
		return readTxn;
	}

	doneReadTxn() {
		if (!this.transaction) return;
		if (--this.readTxnsUsed === 0) {
			trackedTxns.delete(this);
			this.transaction?.abort();
			this.transaction = null;
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
		if (this.open === TRANSACTION_STATE.CLOSED) {
			throw new Error('Can not use a transaction that is no longer open');
		}
		this.writes.push(operation);
		if (!operation.deferSave) {
			// Setting saved to false means to defer saving
			this.save(operation);
		}
		return operation;
	}

	save(operation: TransactionWrite, reloadEntry = false) {
		let txnTime = this.timestamp;
		if (!this.transaction) {
			this.transaction = new RocksTransaction(this.db.store as RocksStore);
			if (txnTime) {
				this.transaction.setTimestamp(txnTime);
			}
		}
		if (this.retries > 0) {
			// this is marks the rocks transaction as a retry so we don't write the transaction log again
			this.transaction.isRetry = true;
		}
		if (!txnTime) txnTime = this.timestamp = this.transaction.getTimestamp();
		if (reloadEntry || operation.entry === undefined) {
			operation.entry = operation.store.getEntry(operation.key, { transaction: this.transaction });
		}
		operation.saved = true;
		// immediately execute in this transaction
		if (operation.validate?.(txnTime) === false) return;
		let result: Promise<void> = operation.before?.() as Promise<void>;
		if (result?.then) this.completions.push(result);
		result = operation.beforeIntermediate?.() as Promise<void>;
		if (result?.then) this.completions.push(result);
		operation.commit(txnTime, operation.entry, this.retries > 0, this.transaction);
	}

	/**
	 * Resolves with information on the timestamp and success of the commit
	 */
	commit(options: CommitOptions = {}): MaybePromise<CommitResolution> {
		for (let i = 0; i < this.writes.length; i++) {
			let operation = this.writes[i];
			if (this.retries === 0 && operation.saved) continue;
			this.save(operation, i < this.validated);
		}
		this.validated = this.writes.length;
		return when(this.completions.length > 0 ? Promise.all(this.completions) : null, () => {
			let commitResolution: MaybePromise<void>;
			if (--this.readTxnsUsed > 0) {
				// we still have outstanding iterators using the transaction, we can't just commit/abort it, we will still
				// need to use it
				commitResolution =
					this.writes.length > 0
						? this.transaction?.commit({ renewAfterCommit: true /* Try to use RocksDB's CommitAndTryCreateSnapshot */ })
						: // don't abort, we still have outstanding reads to complete
							null;
			} else {
				// no more reads need to be performed, just commit/abort based if there are any writes
				trackedTxns.delete(this);
				if (this.transaction) {
					if (this.writes.length > 0) {
						commitResolution = this.transaction.commit();
					} else {
						commitResolution = this.transaction.abort();
						this.transaction = null; // immediately clear transaction, no need to wait
					}
				}
			}

			if (commitResolution) {
				if (!outstandingCommit) {
					outstandingCommit = commitResolution;
					outstandingCommitStart = performance.now();
					outstandingCommit.finally(() => {
						outstandingCommit = null;
					});
				}
				const completions = [];
				return commitResolution.then(
					() => {
						this.transaction = null; // the native transaction is done (reset if needed)
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
										lastWrite.store.getEntry(lastWrite.key).version,
										this.replicatedConfirmation
									)
								);
							}
						}
						// now reset transactions tracking; this transaction be reused and committed again
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
						if (error.code === 'ERR_BUSY') {
							// if the transaction failed due to concurrent changes, we need to retry. First record this as an increased risk of contention/retry
							// for future transactions
							this.retries++;
							return this.commit(options); // try again
						} else throw error;
					}
				);
			}
			const txnResolution: CommitResolution = {
				txnTime: this.timestamp,
			};
			if (this.next) {
				// now run any other transactions
				options.timestamp = this.timestamp;
				const nextResolution = this.next?.commit(options);
				if (nextResolution?.then)
					return nextResolution?.then((nextResolution) => ({
						txnTime: this.timestamp,
						next: nextResolution,
					}));
				txnResolution.next = nextResolution;
			}
			return txnResolution;
		});
	}
	abort(): void {
		while (this.readTxnsUsed > 0) this.doneReadTxn(); // release the read snapshot when we abort, we assume we don't need it
		this.open = TRANSACTION_STATE.CLOSED;
		// reset the transaction
		this.writes = [];
		if (this.#context?.resourceCache) this.#context.resourceCache = null;
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
	save(transaction: ImmediateTransaction) {
		if (this.isCommitting) {
			// if we are in the commit, do the save and force a reload so we get a read within the transaction
			super.save(transaction, true);
		} else {
			this.isCommitting = true;
			return when(this.commit(), () => {
				this.isCommitting = false;
			});
		}
	}

	get timestamp() {
		return this._timestamp || (this._timestamp = getNextMonotonicTime());
	}
	getReadTxn() {
		return; // no transaction means read latest
	}
}

let timer;

function startMonitoringTxns() {
	timer = setInterval(function () {
		for (const txn of trackedTxns) {
			if (txn.timeout <= 0) {
				const url = txn.getContext()?.url;
				harperLogger.error(
					`Transaction was open too long and has been committed, from table: ${
						txn.db?.name + (url ? ' path: ' + url : '')
					}`,
					...(txn.startedFrom ? [`was started from ${txn.startedFrom.resourceName}.${txn.startedFrom.method}`] : []),
					...(DEBUG_LONG_TXNS ? ['starting stack trace', txn.stackTraces] : [])
				);
				// reset the transaction
				try {
					txn.commit();
				} catch (error) {
					harperLogger.debug?.(`Error committing timed out transaction: ${error.message}`);
				}
				txn.timeout = txnExpiration;
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
