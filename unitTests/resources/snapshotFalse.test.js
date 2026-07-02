require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Regression coverage for `snapshot: false` queries (e.g. get_analytics). On RocksDB the read
// transaction is created with snapshots disabled so a long scan does not pin a consistent
// snapshot; on LMDB the flag is a safe no-op. Either way the query must return correct results
// and must NOT throw on the dupSort secondary-index stores Harper uses.
describe('snapshot:false read path', () => {
	let SnapTable;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		SnapTable = table({
			table: 'SnapTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'metric', indexed: true }, // secondary index => dupSort store
				{ name: 'value' },
			],
		});
		for (let i = 0; i < 20; i++) {
			await SnapTable.put({ id: i, metric: i % 2 === 0 ? 'even' : 'odd', value: i * 10 });
		}
	});

	it('primary-key range scan returns correct results with snapshot:false', async function () {
		const results = [];
		for await (const record of SnapTable.search({
			conditions: [{ attribute: 'id', comparator: 'between', value: [5, 9] }],
			snapshot: false,
		})) {
			results.push(record.id);
		}
		assert.deepStrictEqual(
			results.sort((a, b) => a - b),
			[5, 6, 7, 8, 9]
		);
	});

	it('dupSort secondary-index scan does NOT throw with snapshot:false', async function () {
		const results = [];
		for await (const record of SnapTable.search({
			conditions: [{ attribute: 'metric', comparator: 'equals', value: 'even' }],
			snapshot: false,
		})) {
			results.push(record.id);
		}
		assert.strictEqual(results.length, 10); // 0,2,4,...,18
		assert(results.every((id) => id % 2 === 0));
	});

	it('combined secondary-index + pk-range scan works with snapshot:false', async function () {
		const results = [];
		for await (const record of SnapTable.search({
			operation: 'and',
			conditions: [
				{ attribute: 'metric', comparator: 'equals', value: 'odd' },
				{ attribute: 'id', comparator: 'less_than', value: 6 },
			],
			snapshot: false,
		})) {
			results.push(record.id);
		}
		assert.deepStrictEqual(
			results.sort((a, b) => a - b),
			[1, 3, 5]
		);
	});
});
