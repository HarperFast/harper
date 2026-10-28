require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

// More rows than loadLocalRecord's MAX_PREFETCH_SEQUENCE under an indexed condition, so LMDB resolves some
// of them through its prefetch Promise, which the search transform reads through the cache entry's deref()
describe('Collection reads keep @computed attributes on every row', () => {
	const ROW_COUNT = 60;
	const isLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
	let ComputedTable;
	const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		ComputedTable = table({
			table: 'PrefetchComputed',
			database: 'test',
			attributes: [
				// struct-mode records already decode with the record prototype
				{ name: 'id', isPrimaryKey: true, randomAccessFields: false },
				{ name: 'group', indexed: true },
				{ name: 'name' },
				{ name: 'label', computed: true },
			],
		});
		ComputedTable.setComputedAttribute('label', (record) => record.name + ' label');
		for (let i = 0; i < ROW_COUNT; i++) {
			await ComputedTable.put('row-' + i, { id: 'row-' + i, group: 'g', name: 'name-' + i });
		}
	});

	it('every row of an indexed collection read has its computed value, 25 times', async function () {
		const failures = [];
		for (let iteration = 0; iteration < 25; iteration++) {
			const ids = new Set();
			for await (const record of ComputedTable.search({
				conditions: [{ attribute: 'group', comparator: 'equals', value: 'g' }],
			})) {
				ids.add(record.id);
				const expected = 'name-' + record.id.slice(4) + ' label';
				if (record.label !== expected || JSON.parse(JSON.stringify(record)).label !== expected)
					failures.push(`${iteration}:${record.id}`);
			}
			assert.equal(ids.size, ROW_COUNT);
		}
		assert.deepEqual(failures, []);
	});

	it('an LMDB cache entry dereferences to the record its value holds', function () {
		if (!isLmdb) this.skip();
		const store = ComputedTable.primaryStore;
		store.cache.delete('row-3');
		const entry = store.getEntry('row-3');
		assert.equal(entry.deref(), entry.value);
		assert.equal(entry.deref().label, 'name-3 label');
	});

	it('an LMDB cache entry survives garbage collection while its record is cached', async function () {
		if (!isLmdb) this.skip();
		const store = ComputedTable.primaryStore;
		store.cache.delete('row-4');
		store.getEntry('row-4');
		// releases the decoded value the wrapper keeps for the last read
		store.getEntry('row-5');
		for (let i = 0; i < 5; i++) {
			await delay(10);
			global.gc();
		}
		await delay(10);
		assert(store.cache.has('row-4'), 'the cache entry was finalized');
		assert.equal(store.getEntry('row-4').deref().label, 'name-4 label');
	});

	it('a warm LMDB cache entry is not served after another handle commits', async function () {
		if (!isLmdb) this.skip();
		const store = ComputedTable.primaryStore;
		await ComputedTable.put('outside-1', { id: 'outside-1', group: 'h', name: 'first' });
		await ComputedTable.put('outside-2', { id: 'outside-2', group: 'h', name: 'second' });
		assert.equal(store.getEntry('outside-1').value.label, 'first label');
		// a separate, uncached handle on the same database, so its write cannot touch this store's cache
		const outside = store.rootStore.openDB(store.name, { encoding: 'binary', cache: false });
		outside.putSync('outside-1', outside.getBinary('outside-2'));
		const entry = store.getEntry('outside-1');
		assert.equal(entry.value.name, 'second');
		assert.equal(entry.deref().label, 'second label');
	});
});
