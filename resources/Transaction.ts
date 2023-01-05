import { Resource } from './Resource';
import { tables, initTables } from './database';
import { RootDatabase, Transaction as LMDBTransaction } from 'lmdb';
import { Table } from './Table';

initTables();

export class Transaction implements Resource {
	request: any
	fullIsolation: boolean
	restartable: boolean
	lastAccessTime = 0;
	inUseTables = {}
	inUseEnvs = {}
	constructor(request, full_isolation: boolean) {
		this.request = request;
		this.fullIsolation = full_isolation;
		this.restartable = true; // if not restartable and full-isolation is required, need an async-transaction
	}
	updateAccessTime(latest: number) {

	}

	/**
	 * Commit the transaction. This can involve several things based on what type of transaction:
	 * Separate read and read write isolation: Finish the batch, end read transaction
	 * Restartable/optimistic with full isolation: Acquire lock/ownership, complete transaction with optimistic checks, possibly return restart-required
	 * Non-restartable across multiple env/dbs with full isolation: Wait on commit of async-transaction
	 */
	async commit(): Promise<boolean> {
		let txns_with_read_and_writes = [];
		let txns_with_only_writes = []
		let commits = [];
		for (let env_path in this.inUseEnvs) { // TODO: maintain this array ourselves so we don't need to key-ify
			let env_txn = this.inUseEnvs[env_path];
			if (env_txn.writes.length > 0) {
				if (env_txn.conditions.length > 0)
					txns_with_read_and_writes.push(env_txn);
				else // I don't know if these will even be possible, might want to just eliminate this
					txns_with_only_writes.push(env_txn);
			}
		}
		if (txns_with_read_and_writes.length >= 2) {
			// if multiple read+write txns are needed, we switch to a two phase commit approach and first do a request phase
			for (let env_txn of txns_with_read_and_writes) {
				commits.push(env_txn.requestCommit());
			}
			if ((await Promise.all(commits)).indexOf(false) > -1) {
				for (let env_txn of txns_with_read_and_writes) env_txn.abort();
				return false;
			}
			// all requests succeeded, proceed with collecting actual commits
			commits = [];
		}
		for (let env_txn of txns_with_read_and_writes) {
			commits.push(env_txn.commit());
		}
		if (commits.length === 1) { // no two phase commit, so just verify that the single commit succeeds before proceeding
			if (!await commits[0])
				return false;
			commits = [];
		}
		for (let env_txn of txns_with_only_writes) {
			commits.push(env_txn.commit());
		}
		return (await Promise.all(commits)).indexOf(false) === -1;
	}

	subscribe(query: any, options: any) {
		// subscriptionByPrimaryKey.set(id, () => {});
		return {};
	}
	getTable(table_name: string, schema_name?: string): Resource {
		let schema_object = schema_name ? tables[schema_name] : tables;
		let table_txn = this.inUseTables[table_name];
		if (table_txn)
			return table_txn;
		let table: Table = schema_object?.[table_name];
		if (!table) return;
		let key = schema_name ? (schema_name + '/' + table_name) : table_name;
		let env_path = table.envPath;
		let env_txn = this.inUseEnvs[env_path] || (this.inUseEnvs[env_path] = new EnvTransaction());
		return this.inUseTables[key] || (this.inUseTables[key] = table.transaction(env_txn, env_txn.getReadTxn(), this));
	}
}

export class EnvTransaction {
	conditions = [] // the set of reads that were made in this txn, that need to be verified to commit the writes
	writes = [] // the set of writes to commit if the conditions are met
	fullIsolation = false
	inTwoPhase?: boolean
	env: RootDatabase
	readTxn: LMDBTransaction
	getReadTxn() {// used optimistically
		return this.readTxn || (this.readTxn = this.env.useReadTransaction());
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
	 * Resolves to true if the commit succeeded, resolves to false if the commit needs to be retried
	 */
	commit(): Promise<boolean> {
		let remaining_conditions = this.inTwoPhase ? [] : this.conditions.slice(0).reverse();
		let resolution;
		const nextCondition = () => {
			let condition = remaining_conditions.pop();
			if (condition) {
				condition.store.ifVersion(condition.key, condition.version, nextCondition);
			} else {
				for (let write of this.writes) {
					resolution = write.store[write.operation](write.key, write.value);
				}
			}
		}
		nextCondition();
		// TODO: This is where we write to the SharedArrayBuffer so that subscribers from other threads can
		// listen... And then we can use it determine when the commit has been delivered to at least one other
		// node
		return resolution;
	}
}

/*
function example() {
	class MyEndpoint extends Transaction {
		authorize(request) {

		}
		get(id) {
			this.enforceRole('my-role');
			let user = this.userTable.get(id);
			user.entitlements = user.entitlementIds.map(id => this.entitlements.get(id));
			return user;
		}
	}
	MyEndpoint.authorization({
		get: 'my-role'
	})
}*/