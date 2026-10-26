require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { VERSION_REUSED } = require('#src/resources/RecordEncoder');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { RocksDatabase, Transaction } = require('../rocksdbBindings.mts').rocksdbBindings();
const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');
const { transaction } = require('#src/resources/transaction');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// Mirrors rocksdb-js's VerificationTable::valueVersionIsNotUnique, which reads this header from the
// stored value itself:
// https://github.com/HarperFast/rocksdb-js/blob/v2.11.0/src/binding/core/verification_table.h#L59-L74
// Literals, not imported constants: records already on disk carry these exact bits.
const VERSION_HEADER_TAG = 0x0e;
const VERSION_NOT_UNIQUE_FLAG = 0x10000;
function nativeReadsVersionNotUnique(value) {
	if (value.length < 12 || value[8] !== VERSION_HEADER_TAG) return false;
	return (((value[9] << 16) | (value[10] << 8) | value[11]) & VERSION_NOT_UNIQUE_FLAG) !== 0;
}

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
				{ name: 'count' },
				{ name: 'expiresAt', expiresAt: true, indexed: true },
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
		assert(TestTable.primaryStore.verifyVersion(3, entry.version), 'VT slot should be populated after two reads');
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
		assert(!TestTable.primaryStore.verifyVersion(4, oldVersion), 'VT slot should be cleared after write');
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
		const [,] = await Promise.all([TestTable.put(7, { name: 'seven-a' }), TestTable.put(7, { name: 'seven-b' })]);
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

	it('marks a record whose version was reused by a resequenced write in the stored header the VT reads, preserving its expiresAt', async function () {
		const store = TestTable.primaryStore;
		// Raw stored bytes: Harper's own decoder would follow a layout change it made itself.
		await TestTable.put(13, { name: 'base', count: 0 });
		const baseVersion = store.getBinarySync(13).readDoubleBE(0);
		const expiresAt = baseVersion + 60_000;
		await TestTable.patch(13, { count: { __op__: 'add', value: 1 } }, { timestamp: baseVersion + 100 });
		const inOrder = store.getBinarySync(13);
		const inOrderVersion = inOrder.readDoubleBE(0);
		assert(inOrderVersion > baseVersion, 'the in-order write advances the big-endian version at offset 0');
		assert.equal(inOrder[8], VERSION_HEADER_TAG, 'the metadata word starts at offset 8 with its tag byte');
		assert.equal(nativeReadsVersionNotUnique(inOrder), false, 'an advancing write is not flagged');

		await TestTable.patch(13, { count: { __op__: 'add', value: 1 } }, { timestamp: baseVersion + 50, expiresAt });
		const resequencedBytes = store.getBinarySync(13);
		assert.equal(resequencedBytes.readDoubleBE(0), inOrderVersion, 'the resequenced write keeps the existing version');
		assert.equal(resequencedBytes[8], VERSION_HEADER_TAG, 'the metadata word starts at offset 8 with its tag byte');
		assert.equal(
			nativeReadsVersionNotUnique(resequencedBytes),
			true,
			'the reused version is flagged where the VT reads it'
		);
		assert.equal(VERSION_REUSED, VERSION_NOT_UNIQUE_FLAG, 'VERSION_REUSED is the bit records already on disk carry');

		const resequenced = store.getEntry(13);
		assert.equal(resequenced.version, inOrderVersion);
		assert.equal(resequenced.value.count, 2);
		assert.equal(resequenced.expiresAt, expiresAt);
		assert(resequenced.metadataFlags & VERSION_REUSED);
	});

	it('VT does not vouch for a version a resequenced write reused', async function () {
		const store = TestTable.primaryStore;
		const now = Date.now();
		await TestTable.put(9, { name: 'base', count: 0 });
		await TestTable.patch(9, { name: 'newer', count: { __op__: 'add', value: 1 } }, { timestamp: now + 100 });
		await TestTable.get(9);
		const inOrder = store.getEntry(9);
		assert(store.verifyVersion(9, inOrder.version), 'VT should vouch for an in-order version');

		// out-of-order: merges onto the newer record and stores under its (reused) version
		await TestTable.patch(9, { count: { __op__: 'add', value: 1 } }, { timestamp: now + 50 });
		const resequenced = store.getEntry(9);
		assert.equal(resequenced.version, inOrder.version, 'resequenced write keeps the existing version');
		assert.equal(resequenced.value.count, 2, 'both increments are applied');
		assert(resequenced.metadataFlags & VERSION_REUSED, 'the stored record is marked non-unique for the native layer');
		assert(!store.verifyVersion(9, resequenced.version), 'VT must not vouch for a version shared by two stored values');
		assert.notEqual(store.getEntry(9).value, resequenced.value, 'a flagged record is never served from cache');
		assert(!store.verifyVersion(9, resequenced.version), 'reading a flagged record must not publish its version');
		const client = await TestTable.get(9);
		assert.equal(client.count, 2, 'a client-level read sees the merged value, not a stale cache vouch');
	});

	it('an uncachedRead bypasses the cache vouch and returns the stored record', async function () {
		const store = TestTable.primaryStore;
		await TestTable.put(12, { name: 'stored', count: 5 });
		await TestTable.get(12); // warm the cache and seed the VT slot
		const cached = store.getEntry(12);
		assert(store.verifyVersion(12, cached.version), 'VT vouches for the in-order version');
		// the vouch fast path returns the cached object itself, so identity is what distinguishes them
		assert.equal(store.getEntry(12).value, cached.value, 'the vouch path serves the cached object');
		const direct = store.getEntry(12, { uncachedRead: true });
		assert.notEqual(direct.value, cached.value, 'uncachedRead must decode from the store, not serve the cache');
		assert.equal(direct.value.name, 'stored');
		assert.equal(direct.value.count, 5);
		assert.equal(direct.version, cached.version, 'the decoded entry carries the stored version');
	});

	it('an in-order write after a resequenced one restores vouching', async function () {
		const store = TestTable.primaryStore;
		const now = Date.now();
		await TestTable.put(11, { name: 'base', count: 0 });
		await TestTable.patch(11, { name: 'newer', count: { __op__: 'add', value: 1 } }, { timestamp: now + 100 });
		await TestTable.patch(11, { count: { __op__: 'add', value: 1 } }, { timestamp: now + 50 });
		const reused = store.getEntry(11);
		assert(reused.metadataFlags & VERSION_REUSED, 'the reused version is marked');
		assert(!store.verifyVersion(11, reused.version), 'the reused version is not vouched for');

		// the next in-order write gives the record a version of its own; vouching resumes with the
		// same one-read lag as any cold key
		await TestTable.patch(11, { name: 'later' }, { timestamp: now + 200 });
		const advanced = store.getEntry(11);
		assert(advanced.version > reused.version, 'the in-order write advances the version');
		assert.equal(advanced.value.count, 2, 'the merged count survives the in-order write');
		store.getEntry(11);
		assert(store.verifyVersion(11, advanced.version), 'vouching resumes for a version of its own');
	});

	it('a caching read hands rocksdb-js the transaction and version keys, not a copy of the caller options', async function () {
		const store = TestTable.primaryStore;
		await TestTable.put(30, { name: 'thirty' });
		const passed = [];
		const originalGetSync = RocksDatabase.prototype.getSync;
		RocksDatabase.prototype.getSync = function (id, options) {
			if (this === store) passed.push(options);
			return originalGetSync.call(this, id, options);
		};
		const transaction = new Transaction(store.store);
		try {
			// shaped like the DatabaseTransaction HNSW passes as its read options
			const options = { transaction, writes: [], completions: [], readTxnRefCount: 1, timeout: 60_000 };
			const cold = store.getEntry(30, options);
			const warm = store.getEntry(30, options);
			assert.equal(cold.value.name, 'thirty');
			assert.equal(warm.value.name, 'thirty');
			assert.deepStrictEqual(passed, [
				{ transaction, populateVersion: true },
				{ transaction, expectedVersion: cold.version },
			]);
			assert.strictEqual(passed[1].transaction, transaction);

			// the transaction still reaches the native read: its own uncommitted write is visible
			store.putSync(31, { name: 'uncommitted' }, { transaction });
			assert.equal(store.getEntry(31, options)?.value?.name, 'uncommitted');
			assert.equal(store.getEntry(31), undefined);
		} finally {
			RocksDatabase.prototype.getSync = originalGetSync;
			transaction.abort();
		}
	});

	describe('record cache exposure', function () {
		let syncGets;
		let originalGetSync;
		beforeEach(function () {
			syncGets = 0;
			originalGetSync = RocksDatabase.prototype.getSync;
			RocksDatabase.prototype.getSync = function (...args) {
				if (this === TestTable.primaryStore) syncGets++;
				return originalGetSync.apply(this, args);
			};
		});
		afterEach(function () {
			RocksDatabase.prototype.getSync = originalGetSync;
		});

		async function warm(id, name) {
			await TestTable.put(id, { name });
			await TestTable.get(id);
			await TestTable.get(id);
		}

		it('primaryStore.cache is the record cache of a caching table', async function () {
			const cache = TestTable.primaryStore.cache;
			assert(cache, 'a cache:true table exposes its record cache');
			await warm(20, 'twenty');
			assert(cache.get(20), 'a read record is in the exposed cache');
		});

		it('a warm Table.get completes synchronously from the cache, without getSync', async function () {
			await warm(21, 'twenty-one');
			const cachedValue = TestTable.primaryStore.cache.getValue(21);
			syncGets = 0;
			await transaction({}, (txn) => {
				const result = TestTable.get({ id: 21, syncAllowed: true, ensureLoaded: true }, { transaction: txn });
				assert.equal(typeof result?.then, 'undefined', 'a warm hit is not a promise');
				assert.equal(result, cachedValue, 'served from the record cache');
			});
			assert.equal(syncGets, 0, 'a cached record must not route RocksDB reads to a blocking getSync');
		});

		it('a VT hit returns the cached entry without a promise, even when async is requested', async function () {
			await warm(22, 'twenty-two');
			const store = TestTable.primaryStore;
			const entry = store.getEntry(22, { async: true });
			assert.equal(typeof entry?.then, 'undefined');
			assert.equal(entry.value, store.cache.getValue(22), 'served from the record cache');
		});

		it('a save invalidates the cached value', async function () {
			await warm(23, 'twenty-three');
			const store = TestTable.primaryStore;
			assert(store.cache.get(23));
			await TestTable.put(23, { name: 'twenty-three updated' });
			assert.equal(store.cache.get(23), undefined, 'the write dropped the cached value');
			assert.equal((await TestTable.get(23)).name, 'twenty-three updated');
		});

		it('primaryStore.cache.clear() drops cached values, so the next read decodes from the store', async function () {
			await warm(24, 'twenty-four');
			const store = TestTable.primaryStore;
			const cachedValue = store.cache.getValue(24);
			store.cache.clear();
			assert.equal(store.cache.get(24), undefined);
			const record = await TestTable.get(24);
			assert.notEqual(record, cachedValue, 'the record was decoded again, not served from the cache');
			assert.equal(record.name, 'twenty-four');
		});
	});
});
