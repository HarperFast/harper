import { RootDatabase, Transaction as LMDBTransaction } from 'lmdb';
import { DATA, OWN } from './writableRecord';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';

export class DatabaseTransaction {
	conditions = [] // the set of reads that were made in this txn, that need to be verified to commit the writes
	writes = [] // the set of writes to commit if the conditions are met
	updatingRecords?: any[]
	fullIsolation = false
	username: string
	inTwoPhase?: boolean
	lmdbDb: RootDatabase
	readTxn: LMDBTransaction
	constructor(lmdb_db, user) {
		this.lmdbDb = lmdb_db;
		this.username = user?.name;
	}
	getReadTxn() {// used optimistically
		return this.readTxn || (this.readTxn = this.lmdbDb.useReadTransaction());
	}
	doneReading() {
		if (this.readTxn) {
			this.readTxn.done();
			this.readTxn = null;
		}
	}

	recordRead(store, key, version, lock) {
		this.conditions.push({ store, key, version, lock });
	}

	/**
	 * When multiple env/databases are involved in a transaction, we basically do a local two phase commit
	 * using this method to perform the first request (or voting phase). This helps us to eliminate the need
	 * for restarting transactions.
	 */
	requestCommit(): Promise<boolean> {
		this.inTwoPhase = true;
		let first_condition = this.conditions[0];
		if (!first_condition) return Promise.resolve(true);
		return first_condition.store.transaction(() => {
			let rejected;
			for (let condition of this.conditions) {
				rejected = true;
				condition.store.ifVersion(condition.key, condition.version, () => {
					rejected = false;
				});
				if (rejected)
					break;
			}
			return !rejected;
		});
	}

	/**
	 * Resolves with information on the timestamp and success of the commit
	 */
	commit(): Promise<CommitResolution> {
		this.doneReading();
		let remaining_conditions = this.inTwoPhase ? [] : this.conditions.slice(0).reverse();
		let txn_time, resolution;
		const nextCondition = () => {
			let condition = remaining_conditions.pop();
			if (condition) {
				condition.store.ifVersion(condition.key, condition.version, nextCondition);
			} else {
				txn_time = getNextMonotonicTime();
				for (let { txn, record } of this.updatingRecords || []) {
					// TODO: get the own properties, translate to a put and a correct replication operation/CRDT
					let original = record[DATA];
					let own = record[OWN];
					own.__updatedtime__ = txn_time;
					resolution = txn.put(original[txn.constructor.primaryKey], Object.assign({}, original, own));
				}
				for (let write of this.writes) {
					write.value.__updates__.push(txn_time); // TODO: Move to an overflow key in the audit table if this gets too big
					resolution = write.store[write.operation](write.key, write.value, write.version);
				}
				if (this.lmdbDb.auditStore) {
					this.lmdbDb.auditStore.put(txn_time, {
						origin,
						username: this.username,
						operations: this.writes
					});
				}
			}
		};
		nextCondition();
		// TODO: This is where we write to the SharedArrayBuffer so that subscribers from other threads can
		// listen... And then we can use it determine when the commit has been delivered to at least one other
		// node

		// now reset transactions tracking; this transaction be reused and committed again
		this.conditions = [];
		this.writes = [];
		return resolution?.then(resolution => ({
			success: resolution,
			txnTime: txn_time,
		}));
	}
	abort(): void {
		this.doneReading();
		// reset the transaction
		this.conditions = [];
		this.writes = [];
	}
}
interface CommitResolution {
	txnTime: number
	resolution: boolean
}