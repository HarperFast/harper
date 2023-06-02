import { asBinary, Database, getLastVersion, RootDatabase, Transaction as LMDBTransaction } from 'lmdb';
import { EXPLICIT_CHANGES_PROPERTY } from './Resource';
import { UPDATES_PROPERTY } from '../utility/hdbTerms';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';

const MAX_RETRIES = 10;
export class DatabaseTransaction implements Transaction {
	conditions = []; // the set of reads that were made in this txn, that need to be verified to commit the writes
	writes = []; // the set of writes to commit if the conditions are met
	updatingResources?: any[];
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
	addWrite(operation) {
		this.writes.push(operation);
	}
	get hasWritesToCommit() {
		return this.writes.length > 0 || this.updatingResources?.length > 0;
	}

	recordRead(store, key, version, lock) {
		this.conditions.push({ store, key, version, lock });
	}

	/**
	 * Resolves with information on the timestamp and success of the commit
	 */
	async commit(flush = true, retries = 0): Promise<CommitResolution> {
		this.doneReading();
		let resolution,
			resource_resolutions,
			completions = [];
		if (retries === 0) {
			for (const resource of this.updatingResources || []) {
				// eventually we need CRDT handling for changes
				let resource_resolution;
				// TODO: We don't want to go through the public put() method, but still want validation
				if (resource[EXPLICIT_CHANGES_PROPERTY]) {
					const updating_record = Object.assign({}, resource[EXPLICIT_CHANGES_PROPERTY], resource);
					resource_resolution = resource.put(updating_record, { noCopy: true, onlyChanges: true });
				} else resource_resolution = resource.put(resource, { noCopy: true });
				if (resource_resolution?.then) {
					if (!resource_resolutions) resource_resolutions = [];
					resource_resolutions.push(resource_resolution);
				}
			}
		}
		let write_index = 0;
		let last_store;
		let txn_time;
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
					const audit_record = write.commit(retries);
					if (audit_record.completion) {
						if (!completions) completions = [];
						completions.push(audit_record.completion);
						audit_record.completion = undefined;
					}
					last_store = write.store;
					if (this.auditStore) {
						audit_record.username = this.username;
						audit_record.lastVersion = write.lastVersion;
						this.auditStore.put([(txn_time = write.txnTime), write.store.tableId, write.key], audit_record);
					}
				}
			}
		};
		if (resource_resolutions) await Promise.all(resource_resolutions);
		nextCondition();
		//this.auditStore.ifNoExists('txn_time-fix this', nextCondition);
		// TODO: if any of these fail, restart this
		// TODO: This is where we write to the SharedArrayBuffer so that subscribers from other threads can
		// listen... And then we can use it determine when the commit has been delivered to at least one other
		// node

		return resolution?.then((resolution) => {
			if (resolution) {
				completions.push(last_store.flushed);
				return Promise.all(completions).then(() => {
					// now reset transactions tracking; this transaction be reused and committed again
					this.conditions = [];
					this.writes = [];
					return {
						txnTime: txn_time,
					};
				});
			} else {
				if (++retries > MAX_RETRIES) {
					throw new Error('Unable to optimistically update record');
				}
				return this.commit(flush, retries); // try again
			}
		});
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
export interface Transaction {
	commit(flush?: boolean): Promise<CommitResolution>;
	abort?(flush?: boolean): any;
}
export class ImmediateTransaction {
	addWrite(operation) {
		operation.commit();
	}
	get timestamp() {
		return getNextMonotonicTime();
	}
	getReadTxn() {} // no transaction means read latest
}
export const immediateTransaction = new ImmediateTransaction();
