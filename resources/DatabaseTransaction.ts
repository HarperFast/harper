import { Database, RootDatabase, Transaction as LMDBTransaction } from 'lmdb';
import { DATA, OWN } from './WritableRecord';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';

export class DatabaseTransaction {
	conditions = []; // the set of reads that were made in this txn, that need to be verified to commit the writes
	writes = []; // the set of writes to commit if the conditions are met
	updatingRecords?: any[];
	fullIsolation = false;
	username: string;
	inTwoPhase?: boolean;
	lmdbDb: RootDatabase;
	auditStore: Database;
	readTxn: LMDBTransaction;
	constructor(lmdb_db, user, audit_store) {
		this.lmdbDb = lmdb_db;
		this.username = user?.name;
		this.auditStore = audit_store;
	}
	getReadTxn() {
		// used optimistically
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
	 * Resolves with information on the timestamp and success of the commit
	 */
	commit(): Promise<CommitResolution> {
		this.doneReading();
		const remaining_conditions = this.inTwoPhase ? [] : this.conditions.slice(0).reverse();
		let txn_time, resolution, write_resolution;
		const nextCondition = () => {
			const condition = remaining_conditions.pop();
			if (condition) {
				const condition_resolution = condition.store.ifVersion(condition.key, condition.version, nextCondition);
				resolution = resolution || condition_resolution;
			} else {
				txn_time = getNextMonotonicTime();
				for (const { txn, record } of this.updatingRecords || []) {
					// TODO: get the own properties, translate to a put and a correct replication operation/CRDT
					const original = record[DATA];
					const own = record[OWN];
					own.__updatedtime__ = txn_time;
					write_resolution = txn.put(original[txn.constructor.primaryKey], Object.assign({}, original, own));
				}
				for (const write of this.writes) {
					if (this.auditStore && write.store.useVersions) {
						const updates = write.value.__updates__ || (write.value.__updates__ = []);
						updates.push(txn_time); // TODO: Move to an overflow key in the audit table if this gets too big
						this.auditStore.put([txn_time, write.store.tableId, write.key], {
							operation: write.operation,
							username: this.username,
							value: write.value,
						});
					}
					write_resolution = write.store[write.operation]?.(write.key, write.value, txn_time);
				}
			}
		};
		nextCondition();
		// TODO: if any of these fail, restart this
		// TODO: This is where we write to the SharedArrayBuffer so that subscribers from other threads can
		// listen... And then we can use it determine when the commit has been delivered to at least one other
		// node

		// now reset transactions tracking; this transaction be reused and committed again
		this.conditions = [];
		this.writes = [];
		resolution = resolution || write_resolution;
		return resolution?.then((resolution) => ({
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
	txnTime: number;
	resolution: boolean;
}
