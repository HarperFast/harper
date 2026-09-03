require('../testUtils');
const assert = require('node:assert');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { estimateCondition, estimatedEntryCount, intersectionEstimate } = require('#src/resources/search');

describe('estimatedEntryCount', () => {
	const { setupTestDBPath } = require('../testUtils');
	const { table } = require('#src/resources/databases');
	const { setMainIsWorker } = require('#js/server/threads/manageThreads');
	const N = 2000;
	let T;

	before(async function () {
		this.timeout(120000);
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'EntryCountTest',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const written = [];
		for (let i = 0; i < N; i++) {
			written.push(T.put({ id: i }));
		}
		await Promise.all(written);
		if (typeof T.primaryStore.flush === 'function') await T.primaryStore.flush();
	});

	it('reads the O(1) key-count estimate rather than iterating the store', function () {
		const store = T.primaryStore;
		// gate on the engine, not on the method: under RocksDB a renamed or dropped
		// getEstimatedKeyCount must fail this guard rather than silently skip it
		if (!(store instanceof RocksDatabase)) return this.skip();
		store.estimatedEntryCountExpires = 0;
		const getKeysCount = store.getKeysCount;
		store.getKeysCount = () => assert.fail('estimatedEntryCount must not iterate the whole key space');
		let estimate;
		try {
			estimate = estimatedEntryCount(store);
		} finally {
			store.getKeysCount = getKeysCount;
		}
		assert.ok(estimate >= N / 2 && estimate <= N * 2, `estimate ${estimate} is not in range for ${N} rows`);
	});

	it('memoizes the estimate for 10 seconds', () => {
		const store = T.primaryStore;
		store.estimatedEntryCountExpires = 0;
		const first = estimatedEntryCount(store);
		const { getEstimatedKeyCount, getStats } = store;
		const reprobed = () => assert.fail('memoized estimate must not re-probe the store');
		store.getEstimatedKeyCount = reprobed;
		store.getStats = reprobed;
		try {
			assert.strictEqual(estimatedEntryCount(store), first);
		} finally {
			store.getEstimatedKeyCount = getEstimatedKeyCount;
			store.getStats = getStats;
		}
	});
});

describe('a store estimating zero entries', () => {
	// estimate-num-keys reports this for a populated table whose tombstones reach its non-deletions
	const churned = { getStats: () => ({ entryCount: 0 }) };

	it('is reported as zero rather than floored, so callers see the real count', () => {
		assert.strictEqual(estimatedEntryCount(churned), 0);
	});

	it('keeps intersectionEstimate finite', () => {
		churned.estimatedEntryCountExpires = 0;
		assert.strictEqual(intersectionEstimate(churned, 5, 7), 35);
	});

	it('keeps a `ne null` estimate non-negative, so an estimated total is never below zero', () => {
		churned.estimatedEntryCountExpires = 0;
		const table = {
			primaryKey: 'id',
			primaryStore: churned,
			indices: { attr: { getValuesCount: () => 500 } },
			attributes: [],
		};
		const estimated = estimateCondition(table)({ attribute: 'attr', comparator: 'ne', value: null });
		assert.strictEqual(estimated, 0);
	});

	it("keeps an AND group's estimate finite, so the adaptive index guard still applies", () => {
		churned.estimatedEntryCountExpires = 0;
		const table = { primaryKey: 'id', primaryStore: churned, indices: {}, attributes: [] };
		const condition = { operator: 'and', conditions: [{ estimated_count: 10 }, { estimated_count: 20 }] };
		const estimated = estimateCondition(table)(condition);
		assert.strictEqual(estimated, 200);
	});
});
