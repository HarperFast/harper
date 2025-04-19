import type { RootDatabase, Transaction as LMDBTransaction } from 'lmdb';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility.js';
import { ServerError } from '../utility/errors/hdbError.js';
import * as harperLogger from '../utility/logging/harper_logger.js';
import type { Context } from './ResourceInterface.ts';

import * as envMngr from '../utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { convertToMS } from '../utility/common_utils.js';

const MAX_OPTIMISTIC_SIZE = 100;
const trackedTxns = new Set<DatabaseTransaction>();
const MAX_OUTSTANDING_TXN_DURATION = convertToMS(envMngr.get(CONFIG_PARAMS.STORAGE_MAXTRANSACTIONQUEUETIME)) || 45000; // Allow write transactions to be queued for up to 25 seconds before we start rejecting them
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

export class DatabaseTransaction implements Transaction {
	#context: Context;
	writes = []; // the set of writes to commit if the conditions are met
	lmdbDb: RootDatabase;
	readTxn: LMDBTransaction;
	readTxnRefCount: number;
	readTxnsUsed: number;
	validated = 0;
	timestamp = 0;
	declare next: DatabaseTransaction;
	declare stale: boolean;
	overloadChecked: boolean;
	open = TRANSACTION_STATE.OPEN;
	getReadTxn(): LMDBTransaction | void {
		// used optimistically
		this.readTxnRefCount = (this.readTxnRefCount || 0) + 1;
		if (this.stale) this.stale = false;
		if (this.readTxn) {
			if (this.readTxn.openTimer) this.readTxn.openTimer = 0;
			return this.readTxn;
		}
		if (this.open !== TRANSACTION_STATE.OPEN) return; // can not start a new read transaction as there is no future commit that will take place, just have to allow the read to latest database state
		// Get a read transaction from lmdb-js; make sure we do this first, as it can fail, we don't want to leave the transaction in a bad state with readTxnsUsed > 0
		this.readTxn = this.lmdbDb.useReadTransaction();
		this.readTxnsUsed = 1;
		if (this.readTxn.openTimer) this.readTxn.openTimer = 0;
		trackedTxns.add(this);
		return this.readTxn;
	}
	useReadTxn() {
		this.getReadTxn();
		this.readTxn?.use();
		this.readTxnsUsed++;
		return this.readTxn;
	}
	doneReadTxn() {
		if (!this.readTxn) return;
		this.readTxn.done();
		if (--this.readTxnsUsed === 0) {
			trackedTxns.delete(this);
			this.readTxn = null;
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
	addWrite(operation) {
		if (this.open === TRANSACTION_STATE.CLOSED) {
			throw new Error('Can not use a transaction that is no longer open');
		}
		// else
		if (this.open === TRANSACTION_STATE.LINGERING) {
			// if the transaction is lingering, it is already committed, so we need to commit the write immediately
			const immediateTxn = new DatabaseTransaction();
			immediateTxn.addWrite(operation);
			return immediateTxn.commit({});
		} else this.writes.push(operation); // standard path, add to current transaction
	}
	removeWrite(operation) {
		const index = this.writes.indexOf(operation);
		if (index > -1) this.writes[index] = null;
	}

	/**
	 * Resolves with information on the timestamp and success of the commit
	 */
	commit(options: { doneWriting?: boolean; timestamp?: number } = {}): Promise<CommitResolution> {
		let txnTime = this.timestamp;
		if (!txnTime) txnTime = this.timestamp = options.timestamp || getNextMonotonicTime();
		if (!options.timestamp) options.timestamp = txnTime;
		const retries = options.retries || 0;
		// now validate
		if (this.validated < this.writes.length) {
			try {
				const start = this.validated;
				// record the number of writes that have been validated so if we re-execute
				// and the number is increased we can validate the new entries
				this.validated = this.writes.length;
				for (let i = start; i < this.validated; i++) {
					const write = this.writes[i];
					write?.validate?.(this.timestamp);
				}
				let hasBefore;
				for (let i = start; i < this.validated; i++) {
					const write = this.writes[i];
					if (!write) continue;
					if (write.before || write.beforeIntermediate) {
						hasBefore = true;
					}
				}
				// Now we need to let any "before" actions execute. These are calls to the sources,
				// and we want to follow the order of the source sequence so that later, more canonical
				// source writes will finish (with right to refuse/abort) before proceeeding to less
				// canonical sources.
				if (hasBefore) {
					return (async () => {
						try {
							for (let phase = 0; phase < 2; phase++) {
								let completion;
								for (let i = start; i < this.validated; i++) {
									const write = this.writes[i];
									if (!write) continue;
									const before = write[phase === 0 ? 'before' : 'beforeIntermediate'];
									if (before) {
										const nextCompletion = before();
										if (completion) {
											if (completion.push) completion.push(nextCompletion);
											else completion = [completion, nextCompletion];
										} else completion = nextCompletion;
									}
								}
								if (completion) await (completion.push ? Promise.all(completion) : completion);
							}
						} catch (error) {
							this.abort();
							throw error;
						}
						return this.commit(options);
					})();
				}
			} catch (error) {
				this.abort();
				throw error;
			}
		}
		// release the read snapshot so we don't keep it open longer than necessary
		if (!retries) this.doneReadTxn();
		this.open = options?.doneWriting ? TRANSACTION_STATE.LINGERING : TRANSACTION_STATE.OPEN;
		let resolution;
		const completions = [];
		let writeIndex = 0;
		this.writes = this.writes.filter((write) => write); // filter out removed entries
		const doWrite = (write) => {
			write.commit(txnTime, write.entry, retries);
		};
		// this uses optimistic locking to submit a transaction, conditioning each write on the expected version
		const nextCondition = () => {
			const write = this.writes[writeIndex++];
			if (write) {
				if (write.key) {
					if (retries > 0) {
						// if the first optimistic attempt failed, we need to try again with the very latest version
						write.entry = write.store.getEntry(write.key);
					}
					const conditionResolution = write.store.ifVersion(write.key, write.entry?.version ?? null, nextCondition);
					resolution = resolution || conditionResolution;
				} else nextCondition();
			} else {
				for (const write of this.writes) {
					doWrite(write);
				}
			}
		};
		const lmdbDb = this.lmdbDb;
		// only commit if there are writes
		if (this.writes.length > 0) {
			// we also maintain a retry risk for the transaction, which is a measure of how likely it is that the transaction
			// will fail and retry due to contention. This is used to determine when to give up on optimistic writes and
			// use a real (async) transaction to get exclusive access to the data
			if (lmdbDb?.retryRisk) lmdbDb.retryRisk *= 0.99; // gradually decay the retry risk
			if (this.writes.length + (lmdbDb?.retryRisk || 0) < MAX_OPTIMISTIC_SIZE >> retries) nextCondition();
			else {
				// if it is too big to expect optimistic writes to work, or we have done too many retries we use
				// a real LMDB transaction to get exclusive access to reading and writing
				resolution = this.writes[0].store.transaction(() => {
					for (const write of this.writes) {
						// we load latest data while in the transaction
						write.entry = write.store.getEntry(write.key);
						doWrite(write);
					}
					return true; // success. always success
				});
			}
		}

		if (resolution) {
			if (!outstandingCommit) {
				outstandingCommit = resolution;
				outstandingCommitStart = performance.now();
				outstandingCommit.then(() => {
					outstandingCommit = null;
				});
			}

			return resolution.then((resolution) => {
				if (resolution) {
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
						if (confirmReplication && lastWrite)
							completions.push(
								confirmReplication(
									databaseName,
									lastWrite.store.getEntry(lastWrite.key).localTime,
									this.replicatedConfirmation
								)
							);
					}
					// now reset transactions tracking; this transaction be reused and committed again
					this.writes = [];
					this.next = null;
					return Promise.all(completions).then(() => {
						return {
							txnTime,
						};
					});
				} else {
					// if the transaction failed, we need to retry. First record this as an increased risk of contention/retry
					// for future transactions
					if (lmdbDb) lmdbDb.retryRisk = (lmdbDb.retryRisk || 0) + MAX_OPTIMISTIC_SIZE / 2;
					if (options) options.retries = retries + 1;
					else options = { retries: 1 };
					return this.commit(options); // try again
				}
			});
		}
		const txnResolution: CommitResolution = {
			txnTime,
		};
		if (this.next) {
			// now run any other transactions
			const nextResolution = this.next?.commit(options);
			if (nextResolution?.then)
				return nextResolution?.then((nextResolution) => ({
					txnTime,
					next: nextResolution,
				}));
			txnResolution.next = nextResolution;
		}
		return txnResolution;
	}
	abort(): void {
		while (this.readTxnsUsed > 0) this.doneReadTxn(); // release the read snapshot when we abort, we assume we don't need it
		this.open = TRANSACTION_STATE.CLOSED;
		// reset the transaction
		this.writes = [];
	}
	getContext() {
		return this.#context;
	}
	setContext(context) {
		this.#context = context;
	}
}
interface CommitResolution {
	txnTime: number;
	next?: CommitResolution;
}
export interface Transaction {
	commit(options): Promise<CommitResolution>;
	abort?(flush?: boolean): any;
}
export class ImmediateTransaction extends DatabaseTransaction {
	_timestamp: number;
	addWrite(operation) {
		super.addWrite(operation);
		// immediately commit the write
		this.commit();
	}
	get timestamp() {
		return this._timestamp || (this._timestamp = getNextMonotonicTime());
	}
	getReadTxn() {
		return; // no transaction means read latest
	}
}
let txnExpiration = 30000;
let timer;
function startMonitoringTxns() {
	timer = setInterval(function () {
		for (const txn of trackedTxns) {
			if (txn.stale) {
				const url = txn.getContext()?.url;
				harperLogger.error(
					`Transaction was open too long and has been aborted, from table: ${
						txn.lmdbDb?.name + (url ? ' path: ' + url : '')
					}`
				);
				txn.abort();
			} else txn.stale = true;
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
