require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('PrimaryRocksDatabase', function () {
	let TestTable;

	before(async function () {
		if (isLMDB) return this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		TestTable = table({
			table: 'PrimaryRocksTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
			],
		});
	});

	it('Primary store is a PrimaryRocksDatabase instance (and a RocksDatabase)', function () {
		assert(TestTable.primaryStore instanceof PrimaryRocksDatabase);
		assert(TestTable.primaryStore instanceof RocksDatabase);
	});

	it('Basic read/write returns correct value', async function () {
		await TestTable.put(1, { name: 'one' });
		const result = await TestTable.get(1);
		assert.equal(result.name, 'one');
	});

	it('Repeated reads return consistent value', async function () {
		await TestTable.put(2, { name: 'two' });
		const first = await TestTable.get(2);
		const second = await TestTable.get(2);
		assert.equal(first.name, second.name);
	});

	it('VT slot is populated after two reads, enabling fast-path verification', async function () {
		await TestTable.put(3, { name: 'three' });
		// First read: cache cold, entry stored in WeakLRUCache, VT slot not yet populated
		await TestTable.get(3);
		// Second read: cache warm, expectedVersion passed → soft VT miss populates slot
		const entry = await TestTable.primaryStore.getEntry(3);
		assert(entry.version, 'entry should have a version after read');
		assert(
			TestTable.primaryStore.verifyVersion(3, entry.version),
			'VT slot should be populated after two reads'
		);
	});

	it('Third read hits VT fast path (no DB access needed)', async function () {
		await TestTable.put(10, { name: 'ten' });
		await TestTable.get(10); // 1st: populates WeakLRUCache
		const entry = await TestTable.primaryStore.getEntry(10); // 2nd: populates VT
		assert(entry.version);
		// 3rd read: VT slot matches → FRESH returned without DB access; value is still correct
		const result = await TestTable.get(10);
		assert.equal(result.name, 'ten');
		assert(TestTable.primaryStore.verifyVersion(10, entry.version), 'VT should still hold the version');
	});

	it('Write clears VT slot so stale cached version cannot be verified', async function () {
		await TestTable.put(4, { name: 'four' });
		await TestTable.get(4);
		const entry = await TestTable.primaryStore.getEntry(4);
		const oldVersion = entry.version;
		assert(TestTable.primaryStore.verifyVersion(4, oldVersion), 'VT should be populated before write');

		// Write clears the VT slot via LockTracker registerIntent/releaseIntent
		await TestTable.put(4, { name: 'four updated' });
		assert(
			!TestTable.primaryStore.verifyVersion(4, oldVersion),
			'VT slot should be cleared after write'
		);
		// New read should return the updated value
		const updated = await TestTable.get(4);
		assert.equal(updated.name, 'four updated');
	});

	it('Remove clears cache entry and subsequent read returns undefined', async function () {
		await TestTable.put(5, { name: 'five' });
		await TestTable.get(5); // populate cache
		await TestTable.delete(5);
		const result = await TestTable.get(5);
		assert.equal(result, undefined);
	});

	it('Read with a transaction context returns correct value', async function () {
		await TestTable.put(6, { name: 'six' });
		const context = {};
		const result = await TestTable.get(6, context);
		assert.equal(result.name, 'six');
	});

	it('Concurrent writes to the same key both complete with coordinatedRetry', async function () {
		await TestTable.put(7, { name: 'seven' });
		// Fire two concurrent writes; coordinatedRetry means no ERR_BUSY thrown
		const [, ] = await Promise.all([
			TestTable.put(7, { name: 'seven-a' }),
			TestTable.put(7, { name: 'seven-b' }),
		]);
		const result = await TestTable.get(7);
		assert(
			result.name === 'seven-a' || result.name === 'seven-b',
			`Expected one of the concurrent writes to win, got: ${result.name}`
		);
	});

	it('Write followed by immediate read returns the new value, not stale cache', async function () {
		await TestTable.put(8, { name: 'eight' });
		await TestTable.get(8); // populate cache with version T1
		await TestTable.put(8, { name: 'eight updated' }); // clears cache entry
		const result = await TestTable.get(8);
		assert.equal(result.name, 'eight updated');
	});
});
