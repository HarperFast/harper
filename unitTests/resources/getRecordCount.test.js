require('../testUtils');
const assert = require('node:assert/strict');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('Table.getRecordCount', () => {
	let RecordCountTable;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		RecordCountTable = table({
			table: 'RecordCountTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});

		const N = 30;
		let last;
		for (let i = 0; i < N; i++) {
			last = RecordCountTable.put({ id: 'k-' + i, name: 'name-' + i });
		}
		await last;
	});

	it('returns the exact count when the loop completes within the time budget', async function () {
		const result = await RecordCountTable.getRecordCount();
		assert.equal(result.recordCount, 30);
		assert.equal(result.estimatedRange, undefined);
	});

	it('switches to the sampling estimator when the time budget is exhausted', async function () {
		// Force the early-exit branch by giving the loop a 0ms time budget.
		// This is the regression guard for the RocksDB entryCount bug: when
		// `entryCount` was undefined on RocksDB stores, `halfway` became NaN
		// and `entriesScanned < halfway` was always false, so the early-exit
		// never fired and getRecordCount silently full-scanned every table.
		// With a working entryCount we should drop into the sampling path
		// after the first iteration and return an `estimatedRange`.
		const result = await RecordCountTable.getRecordCount({ timeLimit: 0 });
		assert.ok(
			Array.isArray(result.estimatedRange),
			'expected getRecordCount to engage the sampling estimator (estimatedRange should be set)'
		);
		assert.equal(result.estimatedRange.length, 2);
	});
});
