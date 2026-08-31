require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Regression for the `Prefer: count=exact` pagination path on vector/HNSW-sorted queries. An HNSW sort
// returns a bounded, approximate candidate set whose size is chosen from the requested page (minResults =
// offset + limit), so the number of rows drained is NOT the true match count and must never be advertised
// as `count=exact`. The count path reports the total as unavailable (recordCount null, recordCountExact
// false) for such queries instead of a page-size-dependent number.
describe('Table.search count on vector/HNSW-sorted queries (approximate totals)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return; // HNSW is a RocksDB-only custom index
	let VectorCount;
	const TARGET = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		VectorCount = table({
			table: 'VectorCountTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', optimizeRouting: 0.6 }, type: 'Array' },
			],
		});
		let last;
		for (let i = 0; i < 80; i++) {
			const v = [i % 2, i % 3, i % 4, i % 5, i % 6, i % 7, i % 8, i % 9, i % 10, i % 11];
			last = VectorCount.put(i, { vector: v });
		}
		await last;
	});

	const vectorSearch = (limit) =>
		VectorCount.search({
			sort: { attribute: 'vector', target: TARGET, distance: 'cosine' },
			select: ['id', '$distance'],
			limit,
			count: 'exact',
		});

	it('exact: a vector-sorted total is reported unavailable, not a page-size-dependent number', async function () {
		const small = await vectorSearch(5);
		const large = await vectorSearch(40);

		// Pages still materialize (the feature works); it's only the total that can't be trusted as exact.
		assert.strictEqual(small.length, 5);
		assert.ok(large.length > small.length, `expected a larger page, got ${large.length}`);

		// The total must be reported unavailable rather than advertising two different `count=exact` numbers
		// (scanned tracks the requested page size for an approximate candidate set).
		assert.strictEqual(small.recordCount, null, `small total ${small.recordCount} must be unavailable`);
		assert.strictEqual(large.recordCount, null, `large total ${large.recordCount} must be unavailable`);
		assert.strictEqual(small.recordCountExact, false);
		assert.strictEqual(large.recordCountExact, false);
	});
});
