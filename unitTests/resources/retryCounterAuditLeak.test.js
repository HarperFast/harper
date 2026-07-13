require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { setTimeout: delay } = require('node:timers/promises');

// Regression for the isRetry leak: DatabaseTransaction.retries is bumped on a transient conflict and
// never reset, and save() derives `transaction.isRetry` from `this.retries > 0`. A reused
// DatabaseTransaction that conflicted on an earlier batch therefore stamps isRetry=true on the FRESH
// native transaction of its next batch, and RocksTransactionLogStore.put skips the audit/transaction
// -log append for it (`if (options.transaction.isRetry) return`). The record commits and reads back
// locally, but no audit entry is recorded, no 'committed' wake fires, and replication has nothing to
// send: the write is silently dropped from the change feed. Fixed by setting isRetry only on the
// specific native transaction actually being retried and resetting retries after commit.
describe('retries counter must not suppress a fresh write audit entry', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	let LeakTable;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		LeakTable = table({
			table: 'RetryLeakTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }],
			audit: true,
		});
	});

	async function auditEntryCount(id) {
		for (let i = 0; i < 200; i++) {
			let count = 0;
			for (const entry of LeakTable.auditStore.getRange({ start: 1 })) {
				if (entry.recordId === id) count++;
			}
			if (count > 0) return count;
			await delay(10);
		}
		return 0;
	}

	it('a first-attempt write on a transaction carrying retries>0 still records its audit entry', async () => {
		const context = {};
		await transaction(context, async (txn) => {
			// A prior batch on this reused transaction hit a transient conflict; the counter was bumped
			// and never reset. This write is a fresh first attempt (no conflict of its own).
			txn.retries = 1;
			await LeakTable.put('leaked', { id: 'leaked', v: 'kept' }, context);
		});

		assert.equal((await LeakTable.get('leaked'))?.v, 'kept', 'the record itself must commit');
		assert.ok(
			(await auditEntryCount('leaked')) >= 1,
			'the fresh write must record an audit/transaction-log entry even though retries>0 (else replication silently drops it)'
		);
	});

	it('a clean transaction (retries==0) records its audit entry (control)', async () => {
		await LeakTable.put('clean', { id: 'clean', v: 'kept' });
		assert.equal((await LeakTable.get('clean'))?.v, 'kept');
		assert.ok((await auditEntryCount('clean')) >= 1, 'baseline: a normal write is audited');
	});
});
