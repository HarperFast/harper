import { asBinary, Database, getLastVersion, RootDatabase, Transaction as LMDBTransaction } from 'lmdb';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';
import { createAuditEntry } from './auditStore';

export const COMPLETION = Symbol('completion');
const MAX_OPTIMISTIC_SIZE = 100;
export class DatabaseTransaction implements Transaction {
	writes = []; // the set of writes to commit if the conditions are met
	username: string;
	lmdbDb: RootDatabase;
	auditStore: Database;
	readTxn: LMDBTransaction;
	constructor(lmdb_db, user, audit_store) {
		this.lmdbDb = lmdb_db;
		this.username = user?.username;
		this.auditStore = audit_store;
	}
	getReadTxn() {
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

	validate() {
		for (const write of this.writes || []) {
			write.validate?.();
		}
	}
	/**
	 * Resolves with information on the timestamp and success of the commit
	 */
	commit(flush = true, retries = 0): Promise<CommitResolution> {
		this.resetReadSnapshot();
		let resolution,
			completions = [];
		let write_index = 0;
		let last_store;
		let txn_time;
		const doWrite = (write) => {
			const audit_information = write.commit(retries);
			if (audit_information) {
				if (audit_information[COMPLETION]) {
					if (!completions) completions = [];
					completions.push(audit_information[COMPLETION]);
				}
				last_store = write.store;
				if (this.auditStore && audit_information.operation) {
					const key = [(txn_time = write.txnTime), write.store.tableId, write.key];
					if (write.invalidated) key.invalidated = true; // this indicates that audit record is an invalidation, and will be replaced
					this.auditStore.put(key, createAuditEntry(write.lastVersion, this.username, audit_information));
				}
			}
		};
		// this uses optimistic locking to submit a transaction, conditioning each write on the expected version
		const nextCondition = () => {
			const write = this.writes[write_index++];
			if (write) {
				if (write.key) {
					const entry = write.store.getEntry(write.key);
					// if the first optimistic attempt failed, we need to try again with the very latest version
					const version =
						retries === 0 && write.lastVersion !== undefined
							? write.lastVersion
							: (write.lastVersion = entry?.version ?? null);
					const condition_resolution = write.store.ifVersion(write.key, version, nextCondition);
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
			retries = 1; // we go into retry mode so that each commit action reloads the latest data while in the transaction
			resolution = this.writes[0].store.transaction(() => {
				for (const write of this.writes) {
					doWrite(write);
				}
				return true; // success. always success
			});
		}
		//this.auditStore.ifNoExists('txn_time-fix this', nextCondition);

		return resolution?.then((resolution) => {
			if (resolution) {
				if (last_store) completions.push(last_store.flushed);
				return Promise.all(completions).then(() => {
					// now reset transactions tracking; this transaction be reused and committed again
					this.writes = [];
					return {
						txnTime: txn_time,
					};
				});
			} else {
				return this.commit(flush, retries + 1); // try again
			}
		});
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
	commit(flush?: boolean): Promise<CommitResolution>;
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
	getReadTxn() {} // no transaction means read latest
}
