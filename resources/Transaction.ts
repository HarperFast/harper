class Transaction /** Implements Resource (by user) */ {
	constructor(request, full_isolation) {
		// full_isolation means that we use an LMDB asyncTransaction, which is enabled by default for POST,
		// and gives a true isolated transactions with both reads and writes in the same transaction.
		// otherwise we will use a transaction/snapshot for reads and a batch for writes, but won't guarantee
		// that the reads are in the same transaction as the writes
		this.request = request;
		this.fullIsolation = full_isolation;
		this.lastAccessTime = 0;
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

class TransactionalTable /** Implements Resource*/ {
	constructor(table, transaction) {
		this.table = table;
		this.transaction = transaction;
		if (transaction.readOnly)
			this.lmdbTxn = table.useReadTransaction();

	}
	get(key) {
		let entry = this.table.getEntry(key, { txn: this.lmdbTxn });
		this.transaction.lastAccessTime = Math.max(entry.version, this.transaction.lastAccessTime);
		return entry.value;
	}
}

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
}