import { RootDatabase, Transaction as LMDBTransaction } from 'lmdb';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';
import * as harper_logger from '../utility/logging/harper_logger';
import { CONTEXT } from './Resource';

const MAX_OPTIMISTIC_SIZE = 100;
const tracked_txns = new Set<DatabaseTransaction>();
export class DatabaseTransaction implements Transaction {
	writes = []; // the set of writes to commit if the conditions are met
	lmdbDb: RootDatabase;
	readTxn: LMDBTransaction;
	readTxnRefCount: number;
	validated = 0;
	timestamp = 0;
	declare next: DatabaseTransaction;
	declare stale: boolean;
	open = true;
	getReadTxn(): LMDBTransaction | void {
		// used optimistically
		this.readTxnRefCount = (this.readTxnRefCount || 0) + 1;
		if (this.stale) this.stale = false;
		if (this.readTxn) return this.readTxn;
		this.readTxn = this.lmdbDb.useReadTransaction();
		tracked_txns.add(this);
		return this.readTxn;
	}
	disregardReadTxn(): void {
		if (--this.readTxnRefCount === 0) {
			this.resetReadSnapshot();
		}
	}
	resetReadSnapshot() {
		if (this.readTxn) {
			tracked_txns.delete(this);
			this.readTxn.done();
			this.readTxn = null;
		}
	}
	addWrite(operation) {
		this.writes.push(operation);
	}
	removeWrite(operation) {
		const index = this.writes.indexOf(operation);
		if (index > -1) this.writes[index] = null;
	}

	/**
	 * Resolves with information on the timestamp and success of the commit
	 */
	commit(options: { close?: boolean; timestamp?: number } = {}): Promise<CommitResolution> {
		let txn_time = this.timestamp;
		if (!txn_time) txn_time = this.timestamp = options.timestamp = options.timestamp || getNextMonotonicTime();
		const retries = options.retries || 0;
		// release the read snapshot so we don't keep it open longer than necessary
		this.resetReadSnapshot();
		// now validate
		if (this.validated < this.writes.length) {
			const start = this.validated;
			// record the number of writes that have been validated so if we re-execute
			// and the number is increased we can validate the new entries
			this.validated = this.writes.length;
			for (let i = start; i < this.validated; i++) {
				const write = this.writes[i];
				write?.validate?.(this.timestamp);
			}
			let has_before;
			for (let i = start; i < this.validated; i++) {
				const write = this.writes[i];
				if (!write) continue;
				if (write.before || write.beforeIntermediate) {
					has_before = true;
				}
			}
			// Now we need to let any "before" actions execute. These are calls to the sources,
			// and we want to follow the order of the source sequence so that later, more canonical
			// source writes will finish (with right to refuse/abort) before proceeeding to less
			// canonical sources.
			if (has_before) {
				return (async () => {
					for (let phase = 0; phase < 2; phase++) {
						let completion;
						for (let i = start; i < this.validated; i++) {
							const write = this.writes[i];
							if (!write) continue;
							const before = write[phase === 0 ? 'before' : 'beforeIntermediate'];
							if (before) {
								const next_completion = before();
								if (completion) {
									if (completion.push) completion.push(next_completion);
									else completion = [completion, next_completion];
								} else completion = next_completion;
							}
						}
						if (completion) await (completion.push ? Promise.all(completion) : completion);
					}
					return this.commit(options);
				})();
			}
		}
		if (options?.close) this.open = false;
		let resolution,
			completions = [];
		let write_index = 0;
		this.writes = this.writes.filter((write) => write); // filter out removed entries
		const doWrite = (write) => {
			write.commit(txn_time, write.entry, retries);
		};
		// this uses optimistic locking to submit a transaction, conditioning each write on the expected version
		const nextCondition = () => {
			const write = this.writes[write_index++];
			if (write) {
				if (write.key) {
					if (retries > 0) {
						// if the first optimistic attempt failed, we need to try again with the very latest version
						write.entry = write.store.getEntry(write.key);
					}
					const condition_resolution = write.store.ifVersion(write.key, write.entry?.version ?? null, nextCondition);
					resolution = resolution || condition_resolution;
				} else nextCondition();
			} else {
				for (const write of this.writes) {
					doWrite(write);
				}
			}
		};
		if (this.writes.length < MAX_OPTIMISTIC_SIZE >> retries) nextCondition();
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

		if (resolution) {
			return resolution.then((resolution) => {
				if (resolution) {
					if (this.next) {
						completions.push(this.next.commit(options));
					}
					if (options?.flush) {
						completions.push(this.writes[0].store.flushed);
					}
					return Promise.all(completions).then(() => {
						// now reset transactions tracking; this transaction be reused and committed again
						this.writes = [];
						return {
							txnTime: txn_time,
						};
					});
				} else {
					if (options) options.retries = retries + 1;
					else options = { retries: 1 };
					return this.commit(options); // try again
				}
			});
		}
		const txn_resolution: CommitResolution = {
			txnTime: txn_time,
		};
		if (this.next) {
			// now run any other transactions
			const next_resolution = this.next?.commit(options);
			if (next_resolution?.then)
				return next_resolution?.then((next_resolution) => ({
					txnTime: txn_time,
					next: next_resolution,
				}));
			txn_resolution.next = next_resolution;
		}
		return txn_resolution;
	}
	abort(): void {
		this.resetReadSnapshot();
		// reset the transaction
		this.writes = [];
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
let txn_expiration = 30000;
let timer;
function startMonitoringTxns() {
	timer = setInterval(function () {
		for (const txn of tracked_txns) {
			if (txn.stale) {
				const url = txn[CONTEXT]?.url;
				harper_logger.error(
					`Transaction was open too long and has been aborted, from table: ${
						txn.lmdbDb?.name + (url ? ' path: ' + url : '')
					}`
				);
				txn.resetReadSnapshot();
			} else txn.stale = true;
		}
	}, txn_expiration).unref();
}
startMonitoringTxns();
export function setTxnExpiration(ms) {
	clearInterval(timer);
	txn_expiration = ms;
	startMonitoringTxns();
	return tracked_txns;
}
