require('../testUtils');
const assert = require('node:assert');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { setupTestDBPath } = require('../testUtils');
const {
	closeDatabase,
	closeDerivedIndexStore,
	dropDerivedIndexStore,
	openDerivedIndexStore,
	table,
} = require('#src/resources/databases');
const { RocksDerivedIndexStorage } = require('#src/resources/RocksDerivedIndexStorage');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('RocksDerivedIndexStorage', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	let Anchor;
	const opened = [];

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Anchor = table({
			database: 'derived-index-storage',
			table: 'Anchor',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
	});

	after(() => {
		for (const storage of opened) storage.close();
	});

	function open(name) {
		const storage = new RocksDerivedIndexStorage(Anchor.primaryStore.rootStore, name);
		opened.push(storage);
		return storage;
	}

	it('round-trips binary keys and values without crossing namespaces', () => {
		const first = open('__test_derived_first');
		const second = open('__test_derived_second');
		const key = Buffer.from([0, 255, 1]);
		const value = Buffer.from([3, 0, 254]);

		first.write([{ type: 'put', key, value }], 'wal');

		const held = first.read(key);
		first.read(Buffer.from('another read'));
		assert.deepStrictEqual(held, value, 'read buffers remain stable across later reads');
		assert.strictEqual(first.read(Buffer.from([0, 255, 1, 0])), undefined);
		assert.strictEqual(second.read(key), undefined);
	});

	it('cannot alias a Harper internal column family', () => {
		const storage = open('__dbis__');
		const key = Buffer.from('opaque-key');
		storage.write([{ type: 'put', key, value: Buffer.from('opaque-value') }], 'wal');

		assert.strictEqual(Anchor.dbisDB.getSync(key), undefined);
		assert.deepStrictEqual(storage.read(key), Buffer.from('opaque-value'));
	});

	it('prevalidates an entire mutation batch before applying it', () => {
		const storage = open('__test_derived_atomic');
		const key = Buffer.from('key');
		storage.write([{ type: 'put', key, value: Buffer.from('before') }], 'wal');

		assert.throws(
			() =>
				storage.write(
					[
						{ type: 'put', key, value: Buffer.from('after') },
						{ type: 'put', key: Buffer.from('bad'), value: 'not-a-buffer' },
					],
					'wal'
				),
			/values must be Buffers/
		);
		assert.deepStrictEqual(storage.read(key), Buffer.from('before'));
	});

	it('atomically applies puts and deletes through one RocksDB transaction', () => {
		const storage = open('__test_derived_batch');
		const removed = Buffer.from('removed');
		storage.write([{ type: 'put', key: removed, value: Buffer.from('old') }], 'wal');

		storage.write(
			[
				{ type: 'put', key: Buffer.from('first'), value: Buffer.from('one') },
				{ type: 'put', key: Buffer.from('second'), value: Buffer.from('two') },
				{ type: 'delete', key: removed },
			],
			'wal'
		);

		assert.deepStrictEqual(storage.read(Buffer.from('first')), Buffer.from('one'));
		assert.deepStrictEqual(storage.read(Buffer.from('second')), Buffer.from('two'));
		assert.strictEqual(storage.read(removed), undefined);
	});

	it('does not treat a swallowed transaction abort as a committed batch', () => {
		const rootStore = Anchor.primaryStore.rootStore;
		const originalTransactionSync = rootStore.transactionSync;
		rootStore.transactionSync = () => undefined;
		try {
			const storage = open('__test_derived_aborted');
			assert.throws(
				() => storage.write([{ type: 'put', key: Buffer.from('key'), value: Buffer.from('value') }], 'wal'),
				/transaction did not commit/
			);
		} finally {
			rootStore.transactionSync = originalTransactionSync;
		}
	});

	it('rejects WAL-disabled writes before touching RocksDB', () => {
		const storage = open('__test_derived_wal');
		const key = Buffer.from('key');

		assert.throws(
			() => storage.write([{ type: 'put', key, value: Buffer.from('value') }], 'no-wal'),
			/require the RocksDB WAL/
		);
		assert.strictEqual(storage.read(key), undefined);
	});

	it('rejects a root store whose transactions have the WAL disabled', () => {
		const rootStore = Anchor.primaryStore.rootStore;
		const previous = rootStore.store.disableWAL;
		rootStore.store.disableWAL = true;
		try {
			assert.throws(
				() => new RocksDerivedIndexStorage(rootStore, '__test_derived_disabled_root'),
				/WAL-enabled RocksDB root store/
			);
		} finally {
			rootStore.store.disableWAL = previous;
		}
	});

	it('rejects a table or index handle in place of the RocksDB root store', () => {
		assert.throws(
			() => new RocksDerivedIndexStorage(Anchor.primaryStore, '__test_derived_child_handle'),
			/requires the RocksDB root store/
		);
		assert.throws(
			() => new RocksDerivedIndexStorage(Anchor.dbisDB, '__test_derived_metadata_handle'),
			/requires the RocksDB root store/
		);
	});

	it('uses the root database flush as its barrier and preserves bytes across handle reopen', () => {
		const rootStore = Anchor.primaryStore.rootStore;
		const originalFlushSync = rootStore.flushSync;
		let flushOptions;
		rootStore.flushSync = function (options) {
			flushOptions = options;
			return originalFlushSync.call(this, options);
		};

		const key = Buffer.from('durable');
		const value = Buffer.from('value');
		let storage = open('__test_derived_reopen');
		try {
			storage.write([{ type: 'put', key, value }], 'wal');
			storage.sync();
		} finally {
			rootStore.flushSync = originalFlushSync;
			storage.close();
		}

		assert.deepStrictEqual(flushOptions, { allowWriteStall: true });
		storage = open('__test_derived_reopen');
		assert.deepStrictEqual(storage.read(key), value);
	});

	it('drops and recreates a retired derived column family', () => {
		const key = Buffer.from('retired');
		let storage = open('__test_derived_drop');
		const otherWorker = open('__test_derived_drop');
		storage.write([{ type: 'put', key, value: Buffer.from('value') }], 'wal');
		storage.drop();
		assert.doesNotThrow(() => otherWorker.drop(), 'a redundant worker drop is successful');

		assert.throws(() => storage.read(key), /storage is closed/);
		storage = open('__test_derived_drop');
		assert.strictEqual(storage.read(key), undefined);
	});

	it('preserves a drop failure when closing the failed handle also fails', () => {
		const rootStore = Anchor.primaryStore.rootStore;
		const store = openDerivedIndexStore(rootStore, '__test_derived_drop_error');
		const originalDropSync = store.dropSync;
		const originalClose = store.close;
		store.dropSync = () => {
			throw new Error('injected drop failure');
		};
		store.close = () => {
			throw new Error('injected close failure');
		};
		try {
			assert.throws(() => dropDerivedIndexStore(rootStore, store), /injected drop failure/);
		} finally {
			store.dropSync = originalDropSync;
			store.close = originalClose;
			closeDerivedIndexStore(rootStore, store);
		}
	});

	it("closes its own handle without closing Harper's root database", async () => {
		const storage = open('__test_derived_close');
		storage.close();

		assert.throws(() => storage.read(Buffer.from('key')), /storage is closed/);
		await Anchor.put('root-still-open', {});
		assert.ok(await Anchor.get('root-still-open'));
	});

	it('retains a failed close for a later retry', () => {
		const storage = open('__test_derived_close_retry');
		const originalClose = RocksDatabase.prototype.close;
		let fail = true;
		RocksDatabase.prototype.close = function () {
			if (fail && this.name.includes('__test_derived_close_retry')) {
				fail = false;
				throw new Error('injected close failure');
			}
			return originalClose.call(this);
		};
		try {
			assert.throws(() => storage.close(), /injected close failure/);
			assert.doesNotThrow(() => storage.close());
		} finally {
			RocksDatabase.prototype.close = originalClose;
		}
	});

	it('is invalidated when Harper closes its root database', () => {
		const Closing = table({
			database: 'derived-index-storage-close',
			table: 'Anchor',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const rootStore = Closing.primaryStore.rootStore;
		const storage = new RocksDerivedIndexStorage(rootStore, '__test_derived_root_close');
		opened.push(storage);

		assert.strictEqual(closeDatabase('derived-index-storage-close'), true);
		assert.throws(() => storage.read(Buffer.from('key')), /storage is closed/);
		assert.throws(
			() => new RocksDerivedIndexStorage(rootStore, '__test_derived_after_root_close'),
			/closed RocksDB root store/
		);
	});
});
