import { Resource } from './Resource';
import { tables, initTables } from './database';

initTables();

export class Transaction implements Resource {
	request: any
	fullIsolation: boolean
	restartable: boolean
	lastAccessTime: number
	inUseTables = {}
	inUseEnvs = {}
	constructor(request, full_isolation: boolean) {
		// full_isolation means that we use an LMDB asyncTransaction, which is enabled by default for POST,
		// and gives a true isolated transactions with both reads and writes in the same transaction.
		// otherwise we will use a transaction/snapshot for reads and a batch for writes, but won't guarantee
		// that the reads are in the same transaction as the writes
		this.request = request;
		this.fullIsolation = full_isolation;
		this.restartable = true; // if not restartable and full-isolation is required, need an async-transaction
		this.lastAccessTime = 0;
		this.inUse = {};
	}
	updateAccessTime() {

	}

	/**
	 * Commit the transaction. This can involve several things based on what type of transaction:
	 * Separate read and read write isolation: Finish the batch, end read transaction
	 * Restartable/optimistic with full isolation: Acquire lock/ownership, complete transaction with optimistic checks, possibly return restart-required
	 * Non-restartable with full isolation: Wait on commit of async-transaction
	 */
	commit(): Promise<any> | void {

	}
	subscribe(query: any, options: any) {
		// subscriptionByPrimaryKey.set(id, () => {});
		return {};
	}
	getTable(table_name: string, schema_name?: string): Transaction {
		let schema_object = schema_name ? tables[schema_name] : tables;
		let table_txn = this.inUseTables[table_name];
		if (table_txn)
			return table_txn;
		let table = schema_object?.[table_name];
		if (!table) return;
		let key = schema_name ? (schema_name + '/' + table_name) : table_name;
		let env_path = table.envPath;
		let env_txn = this.inUseEnvs[env_path] || (this.inUseEnvs[env_path] = new EnvTransaction());
		return this.inUseTables[key] || (this.inUseTables[key] = table.transaction(env_txn));
	}
}
function setupTransaction(schemas) {
	for (let name in schemas) {
		let table = schemas[name];
		Object.defineProperty(Transaction.prototype, name, {
			get() {
				return new TransactionalTable(table, this);
			}
		});
	}
}


export class EnvTransaction {
	conditions = [] // the set of reads that were made in this txn, that need to be verified to commit the writes
	writes = [] // the set of writes to commit if the conditions are met
	getReadTxn() {// used by GET and PUT
		return this.readTxn || (this.readTxn = lmdbEnv.getReadTxn());
	}

	getFullWriteTxn() {

	}
	commit(): Promise<any> | void {

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