import { Resource } from './Resource';
import { tables, initTables } from './database';

initTables();

export class Transaction implements Resource {
	request: any
	fullIsolation: boolean
	restartable: boolean
	lastAccessTime: number
	constructor(request, full_isolation: boolean) {
		// full_isolation means that we use an LMDB asyncTransaction, which is enabled by default for POST,
		// and gives a true isolated transactions with both reads and writes in the same transaction.
		// otherwise we will use a transaction/snapshot for reads and a batch for writes, but won't guarantee
		// that the reads are in the same transaction as the writes
		this.request = request;
		this.fullIsolation = full_isolation;
		this.restartable = true; // if not restartable and full-isolation is required, need an async-transaction
		this.lastAccessTime = 0;
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
	getTable(table_name: string, schema_name?: string): TransactionalTable {
		let table = tables[table_name];
		return table && new TransactionalTable(table, this);
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

class TransactionalTable implements Resource {
	table: any
	transaction: Transaction
	lmdbTxn: any
	lastAccessTime: number
	constructor(table, transaction) {
		this.table = table;
		this.transaction = transaction;
		if (transaction.readOnly)
			this.lmdbTxn = table.useReadTransaction();

	}
	get(key) {
		let record = this.table.get(key, { txn: this.lmdbTxn });
		this.transaction.lastAccessTime = Math.max(this.table.lastAccessTime, this.transaction.lastAccessTime);
		return record;
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