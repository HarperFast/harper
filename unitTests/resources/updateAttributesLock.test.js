require('../testUtils');
const assert = require('assert');
const { Worker } = require('worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { database, table } = require('#src/resources/databases');
const {
	acquireUpdateAttributesLock,
	releaseUpdateAttributesLock,
	withUpdateAttributesLock,
	UPDATE_ATTRIBUTES_LOCK_TIMEOUT,
} = require('#src/resources/Table');
const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const TEST_DB = 'test';
const LOCK_KEY = 'update-attributes';

function runWorkerAction(message, expectedMessageTypes, hardTimeout) {
	return new Promise((resolve, reject) => {
		const workerThread = new Worker(__dirname + '/updateAttributesLock-thread.js', {
			workerData: { addPorts: [] },
		});
		const received = [];
		let finished = false;
		let timer;
		const finish = (callback) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			workerThread.removeAllListeners();
			workerThread.terminate().then(callback, reject);
		};
		timer = setTimeout(
			() => finish(() => reject(new Error(`worker action '${message.type}' exceeded its ${hardTimeout}ms watchdog`))),
			hardTimeout
		);
		workerThread.on('message', (result) => {
			if (!expectedMessageTypes.includes(result.type)) return;
			received.push(result);
			if (received.length === expectedMessageTypes.length) finish(() => resolve(received));
		});
		workerThread.once('error', (error) => finish(() => reject(error)));
		workerThread.once('exit', (code) =>
			finish(() => reject(new Error(`worker action '${message.type}' exited before completing (code ${code})`)))
		);
		workerThread.postMessage(message);
	});
}

// harper#2251: bounded acquire (throw instead of spinning a core forever) + structural release
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
		assert.strictEqual(result, 42);
		assert.ok(rootStore.tryLock(LOCK_KEY), 'lock should be free after the callback completed');
		rootStore.unlock(LOCK_KEY);
	});

	it('throws ServerError after the deadline when the lock is never released', async () => {
		const [result] = await runWorkerAction({ type: 'helper-deadline', timeout: 250 }, ['deadline-result'], 5000);
		assert.ok(result.acquired, 'test worker should be able to take the lock to wedge it');
		assert.ok(result.error.isServerError, 'deadline should throw ServerError');
		assert.strictEqual(result.error.statusCode, 503);
		assert.strictEqual(result.error.code, 'UPDATE_ATTRIBUTES_LOCK_TIMEOUT');
		assert.strictEqual(result.error.retryable, true);
		assert.ok(result.error.message.includes(LOCK_KEY), 'message should name the lock');
		assert.ok(result.error.message.includes(`table '${TEST_DB}.Wedged'`), 'message should name the table in scope');
		assert.ok(/\d+ms/.test(result.error.message), 'message should report the elapsed deadline');
		assert.ok(result.elapsed >= 240, `should have waited out the deadline, threw after ${result.elapsed}ms`);
		assert.ok(result.elapsed < 5000, `should throw shortly after the deadline, took ${result.elapsed}ms`);
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

	it('rejects asynchronous guarded callbacks and releases the lock', () => {
		assert.throws(
			() => withUpdateAttributesLock(rootStore, `table '${TEST_DB}.Async'`, () => Promise.resolve(42)),
			/withUpdateAttributesLock callback must be synchronous/
		);
		assert.ok(rootStore.tryLock(LOCK_KEY), 'lock should be released after rejecting an asynchronous callback');
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

	it('releases the lock before recursively reloading a concurrently-created table', function () {
		this.timeout(30000);
		const definition = {
			table: 'ConcurrentCreate',
			database: TEST_DB,
			attributes: [{ name: 'id', type: 'Int', isPrimaryKey: true }],
		};
		const originalGetSync = PrimaryRocksDatabase.prototype.getSync;
		let intercepted = false;
		PrimaryRocksDatabase.prototype.getSync = function (key) {
			if (!intercepted && key?.toString() === 'ConcurrentCreate/') {
				intercepted = true;
				PrimaryRocksDatabase.prototype.getSync = originalGetSync;
				return { name: 'id' };
			}
			return originalGetSync.apply(this, arguments);
		};
		try {
			assert.ok(table(definition), 'recursive reload should complete after releasing the non-reentrant lock');
		} finally {
			PrimaryRocksDatabase.prototype.getSync = originalGetSync;
		}
		assert.ok(intercepted, 'test should drive the concurrently-created branch');
		assert.ok(rootStore.tryLock(LOCK_KEY), 'lock should be free after the recursive reload');
		rootStore.unlock(LOCK_KEY);
	});

	it('a real table() operation fails with ServerError after the full deadline when the lock is wedged', async function () {
		this.timeout(30000);
		const [deadlineResult, createResult] = await runWorkerAction(
			{ type: 'table-deadline' },
			['deadline-result', 'table-created'],
			20000
		);
		assert.ok(deadlineResult.acquired, 'test worker should be able to wedge the lock');
		assert.ok(deadlineResult.error.isServerError, 'production table() path should throw ServerError');
		assert.strictEqual(deadlineResult.error.statusCode, 503);
		assert.strictEqual(deadlineResult.error.code, 'UPDATE_ATTRIBUTES_LOCK_TIMEOUT');
		assert.strictEqual(deadlineResult.error.retryable, true);
		assert.ok(deadlineResult.error.message.includes(LOCK_KEY), 'message should name the lock');
		assert.ok(
			deadlineResult.error.message.includes(`table '${TEST_DB}.DeadlineWedged'`),
			'message should name the table'
		);
		assert.ok(
			deadlineResult.elapsed >= UPDATE_ATTRIBUTES_LOCK_TIMEOUT - 500,
			`should have waited the full update-attributes deadline, threw after ${deadlineResult.elapsed}ms`
		);
		assert.ok(
			deadlineResult.elapsed < UPDATE_ATTRIBUTES_LOCK_TIMEOUT + 5000,
			`should throw shortly after the deadline, took ${deadlineResult.elapsed}ms`
		);
		assert.ok(createResult.created, `create should succeed after the lock is released: ${createResult.error ?? ''}`);
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
				workerThread.postMessage({ type: 'hold-lock' });
			});
			assert.ok(held.acquired, 'worker thread should have taken the lock');
			const bufferKeyAcquired = rootStore.tryLock(Buffer.from(LOCK_KEY));
			if (bufferKeyAcquired) rootStore.unlock(Buffer.from(LOCK_KEY));
			assert.strictEqual(bufferKeyAcquired, false, 'Buffer and string keys must address the same held lock');
			workerThread.postMessage({ type: 'release-lock', holdTime: 300 });
			const startTime = Date.now();
			acquireUpdateAttributesLock(rootStore, `table '${TEST_DB}.Contended'`);
			const elapsed = Date.now() - startTime;
			releaseUpdateAttributesLock(rootStore);
			assert.ok(elapsed < 5000, `should acquire promptly after release, took ${elapsed}ms`);
		} finally {
			await workerThread.terminate();
		}
	});
});
