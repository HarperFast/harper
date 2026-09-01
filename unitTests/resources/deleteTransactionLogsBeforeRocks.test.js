/**
 * Regression guards for harper#2049: on RocksDB, all tables in a database share one
 * transaction log with no per-table purge granularity, so a table-scoped
 * delete_transaction_logs_before used to silently purge EVERY table's log in the
 * database. A nonexistent table name (e.g. a typo) fell through to the same
 * whole-database purge. Both must be rejected before any purge happens.
 */
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const harperBridge = require('#src/dataLayer/harperBridge/harperBridge').default;

describe('deleteTransactionLogsBefore on RocksDB (harper#2049)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	const DB = 'txnLogPurgeScope';
	let TableA, TableB;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }];
		TableA = table({ table: 'TableA', database: DB, attributes });
		TableB = table({ table: 'TableB', database: DB, attributes });
		await TableA.put(1, { name: 'a1' });
		await TableA.put(2, { name: 'a2' });
		await TableB.put(1, { name: 'b1' });
	});

	async function historyCount(tbl) {
		let count = 0;
		for await (const _entry of tbl.getHistory()) count++;
		return count;
	}

	it('rejects a table-scoped delete with a 400 and purges nothing', async () => {
		await assert.rejects(
			harperBridge.deleteTransactionLogsBefore({ database: DB, table: 'TableA', timestamp: Date.now() + 1000 }),
			(error) => {
				assert.strictEqual(error.statusCode, 400);
				assert.match(error.message, /not supported for RocksDB/);
				return true;
			}
		);
		assert.ok((await historyCount(TableA)) >= 2, 'TableA history should be untouched');
		assert.ok((await historyCount(TableB)) >= 1, 'TableB history should be untouched');
	});

	it('rejects a nonexistent table with a 404 instead of purging the whole database', async () => {
		await assert.rejects(
			harperBridge.deleteTransactionLogsBefore({ database: DB, table: 'NoSuchTable', timestamp: Date.now() + 1000 }),
			(error) => {
				assert.strictEqual(error.statusCode, 404);
				return true;
			}
		);
		assert.ok((await historyCount(TableA)) >= 2, 'TableA history should be untouched');
		assert.ok((await historyCount(TableB)) >= 1, 'TableB history should be untouched');
	});

	it('treats a falsy table name as table-scoped rather than database-wide', async () => {
		// A table named "0" addressed numerically must not fall into the no-table
		// branch (which would purge the whole database's log on RocksDB).
		table({ table: '0', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		await assert.rejects(
			harperBridge.deleteTransactionLogsBefore({ database: DB, table: 0, timestamp: Date.now() + 1000 }),
			(error) => {
				assert.strictEqual(error.statusCode, 400);
				assert.match(error.message, /not supported for RocksDB/);
				return true;
			}
		);
	});

	it('rejects a nonexistent database with a 404', async () => {
		await assert.rejects(
			harperBridge.deleteTransactionLogsBefore({ database: 'NoSuchDatabase', timestamp: Date.now() + 1000 }),
			(error) => {
				assert.strictEqual(error.statusCode, 404);
				return true;
			}
		);
	});

	it('still performs the database-wide purge when no table is given', async () => {
		const results = await harperBridge.deleteTransactionLogsBefore({ database: DB, timestamp: Date.now() + 1000 });
		assert.ok(results, 'should return results rather than throw');
		assert.strictEqual(typeof results.entries_deleted, 'number');
		assert.strictEqual(typeof results.log_files_deleted, 'number');
	});

	it('rejects a prune bound the audit range would honor as a whole-log delete (harper#2447)', async () => {
		// Audit keys are raw float64, so NaN and negatives sort above every real timestamp and the prune
		// range spans the whole log. A non-numeric timestamp reaches that via Number.parseInt.
		for (const timestamp of ['yesterday', -1, -0, Number.NaN, new Date('nonsense'), undefined]) {
			await assert.rejects(
				harperBridge.deleteTransactionLogsBefore({ database: DB, timestamp }),
				(error) => {
					assert.strictEqual(error.statusCode, 400, `${String(timestamp)} should be a client error`);
					assert.match(error.message, /non-negative epoch time/);
					return true;
				},
				`timestamp ${String(timestamp)} must be refused`
			);
		}
	});

	it('accepts every legitimate timestamp shape', async () => {
		for (const timestamp of [Date.now(), String(Date.now()), new Date(), 0, '0']) {
			const results = await harperBridge.deleteTransactionLogsBefore({ database: DB, timestamp });
			assert.strictEqual(typeof results.log_files_deleted, 'number', `${String(timestamp)} should be accepted`);
		}
	});

	it('raises the audit staleness floor to the purge cutoff (harper#2447)', async () => {
		const timestamp = Date.now() + 2000;
		await harperBridge.deleteTransactionLogsBefore({ database: DB, timestamp });
		assert.strictEqual(TableA.oldestRetainedAuditTime(), timestamp);
		assert.strictEqual(TableB.oldestRetainedAuditTime(), timestamp, 'the floor is database-scoped');
	});
});
