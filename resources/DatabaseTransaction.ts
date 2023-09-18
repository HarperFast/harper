import { RootDatabase, Transaction as LMDBTransaction } from 'lmdb';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';

const MAX_OPTIMISTIC_SIZE = 100;
let node_ids: Map;
export class DatabaseTransaction implements Transaction {
	writes = []; // the set of writes to commit if the conditions are met
	lmdbDb: RootDatabase;
	readTxn: LMDBTransaction;
	validated = false;
	declare next: DatabaseTransaction;
	open = true;
	getReadTxn(): LMDBTransaction | void {
		// used optimistically
		return this.readTxn || (this.readTxn = this.lmdbDb.useReadTransaction());
	}
	resetReadSnapshot() {
		if (this.readTxn) {
			this.readTxn.done();
			this.readTxn = null;
		}
	}
	addWrite(operation) {
		this.writes.push(operation);
	}
	removeWrite(operation) {
		const index = this.writes.indexOf(operation);
		if (index > -1) this.writes.splice(index, 1);
	}

	validate() {
		this.validated = true;
		for (const write of this.writes || []) {
			write.validate?.();
		}
	}
	/**
	 * Resolves with information on the timestamp and success of the commit
	 */
	commit(txn_time = getNextMonotonicTime(), flush = true, retries = 0): Promise<CommitResolution> {
		this.resetReadSnapshot();
		if (!this.validated) {
			this.validate();
			if (this.next) this.next.validate?.();
		}
		let resolution,
			completions = [];
		let write_index = 0;
		const doWrite = (write) => {
			const completion = write.commit(txn_time, write.entry, retries);
			if (completion) {
				if (!completions) completions = [];
				completions.push(completion);
			}
		};
		// this uses optimistic locking to submit a transaction, conditioning each write on the expected version
		const nextCondition = () => {
			const write = this.writes[write_index++];
			if (write) {
				if (write.key) {
					if (retries > 0) {
						if (write.noRetry) nextCondition();
						else {
							// if the first optimistic attempt failed, we need to try again with the very latest version
							write.entry = write.store.getEntry(write.key);
						}
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
		//this.auditStore.ifNoExists('txn_time-fix this', nextCondition);

		if (resolution) {
			return resolution.then((resolution) => {
				if (resolution) {
					if (this.next) completions.push(this.next.commit(txn_time, flush));
					if (flush) completions.push(this.writes[0].store.flushed);
					return Promise.all(completions).then(() => {
						// now reset transactions tracking; this transaction be reused and committed again
						this.writes = [];
						return {
							txnTime: txn_time,
						};
					});
				} else {
					return this.commit(txn_time, flush, retries + 1); // try again
				}
			});
		}
		return {
			txnTime: txn_time,
		};
	}
	abort(): void {
		this.resetReadSnapshot();
		// reset the transaction
		this.writes = [];
	}
}
interface CommitResolution {
	txnTime: number;
	resolution: boolean;
}
export interface Transaction {
	commit(timestamp: number, flush?: boolean): Promise<CommitResolution>;
	abort?(flush?: boolean): any;
}
export class ImmediateTransaction extends DatabaseTransaction {
	_timestamp: number;
	addWrite(operation) {
		super.addWrite(operation);
		// immediately commit the write
		this.commit(this.timestamp, false);
	}
	get timestamp() {
		return this._timestamp || (this._timestamp = getNextMonotonicTime());
	}
	getReadTxn() {
		return; // no transaction means read latest
	}
}
