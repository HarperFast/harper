require('../testUtils');
const assert = require('assert');
const { Worker } = require('worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { database, table } = require('#src/resources/databases');
const {
	acquireUpdateAttributesLock,
	releaseUpdateAttributesLock,
	withUpdateAttributesLock,
} = require('#src/resources/Table');
const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');
const { ServerError } = require('#src/utility/errors/hdbError');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const TEST_DB = 'test';
const LOCK_KEY = 'update-attributes';

// Regression tests for harper#2251: the exclusive 'update-attributes' lock must be acquired with a
// bounded wait (throwing instead of spinning a core forever when the holder never releases) and must
// be released structurally on every exit path of the schema-update code it guards.
describe('update-attributes exclusive lock', () => {
	let rootStore;
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		rootStore = database({ database: TEST_DB, table: null });
		// the lock helpers are RocksDB-only; the LMDB path uses a transaction lock instead
		if (!(rootStore instanceof RocksDatabase)) this.skip();
	});

	it('acquires immediately when uncontended and releases on completion', () => {
		const result = withUpdateAttributesLock(rootStore, `table '${TEST_DB}.Uncontended'`, () => 42);
		assert.equal(result, 42);
		assert.ok(rootStore.tryLock(LOCK_KEY), 'lock should be free after the callback completed');
		rootStore.unlock(LOCK_KEY);
	});

	it('throws ServerError after the deadline when the lock is never released', () => {
		assert.ok(rootStore.tryLock(LOCK_KEY), 'test should be able to take the lock to wedge it');
		const startTime = Date.now();
		try {
			assert.throws(
				() => acquireUpdateAttributesLock(rootStore, `table '${TEST_DB}.Wedged'`, 250),
				(error) => {
					assert.ok(error instanceof ServerError, `expected ServerError, got ${error.constructor.name}`);
					assert.ok(error.message.includes(LOCK_KEY), 'message should name the lock');
					assert.ok(error.message.includes(`table '${TEST_DB}.Wedged'`), 'message should name the table in scope');
					assert.ok(/\d+ms/.test(error.message), 'message should report the elapsed deadline');
					return true;
				}
			);
			const elapsed = Date.now() - startTime;
			assert.ok(elapsed >= 240, `should have waited out the deadline, threw after ${elapsed}ms`);
			assert.ok(elapsed < 5000, `should throw shortly after the deadline, took ${elapsed}ms`);
		} finally {
			rootStore.unlock(LOCK_KEY);
		}
	});

	it('releases the lock when the guarded callback throws', () => {
		assert.throws(
			() =>
				withUpdateAttributesLock(rootStore, `table '${TEST_DB}.Throwing'`, () => {
					throw new Error('boom');
				}),
			/boom/
		);
		assert.ok(rootStore.tryLock(LOCK_KEY), 'lock should have been released despite the throw');
		rootStore.unlock(LOCK_KEY);
	});

	it('table() releases the lock when a schema update throws mid-flight', function () {
		this.timeout(30000);
		const attributes = [
			{ name: 'id', type: 'Int', isPrimaryKey: true },
			{ name: 'extra', type: 'String', indexed: true },
		];
		table({ table: 'LockLeak', database: TEST_DB, attributes });
		// Reload the schema without 'extra' while the catalog remove throws: table() takes the
		// exclusive lock just before removing the dropped attribute, so the throw escapes from
		// inside the locked region and must not leak the lock.
		const originalRemoveSync = PrimaryRocksDatabase.prototype.removeSync;
		PrimaryRocksDatabase.prototype.removeSync = function () {
			throw new Error('simulated catalog failure');
		};
		try {
			assert.throws(
				() => table({ table: 'LockLeak', database: TEST_DB, attributes: [attributes[0]] }),
				/simulated catalog failure/
			);
		} finally {
			PrimaryRocksDatabase.prototype.removeSync = originalRemoveSync;
		}
		assert.ok(rootStore.tryLock(LOCK_KEY), 'exclusive lock must not leak when table() throws');
		rootStore.unlock(LOCK_KEY);
		// a subsequent schema update must succeed rather than wedge — restore the original definition
		table({ table: 'LockLeak', database: TEST_DB, attributes });
	});

	it('waits for a briefly-held lock and acquires once the holding thread releases', async function () {
		this.timeout(30000);
		const workerThread = new Worker(__dirname + '/updateAttributesLock-thread.js', {
			workerData: { addPorts: [] },
		});
		try {
			const held = await new Promise((resolve, reject) => {
				workerThread.once('message', resolve);
				workerThread.once('error', reject);
				workerThread.postMessage({ type: 'hold-lock', holdTime: 300 });
			});
			assert.ok(held.acquired, 'worker thread should have taken the lock');
			const startTime = Date.now();
			// blocks synchronously; the worker's timer releases the lock from its own event loop,
			// which the bounded wait observes through the native shared lock state
			acquireUpdateAttributesLock(rootStore, `table '${TEST_DB}.Contended'`);
			const elapsed = Date.now() - startTime;
			releaseUpdateAttributesLock(rootStore);
			assert.ok(elapsed >= 200, `should have waited for the holder, waited ${elapsed}ms`);
			assert.ok(elapsed < 5000, `should acquire promptly after release, took ${elapsed}ms`);
		} finally {
			await workerThread.terminate();
		}
	});
});
