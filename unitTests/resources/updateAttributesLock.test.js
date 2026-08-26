const assert = require('assert');
const { Worker } = require('worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { database, table } = require('#src/resources/databases');
const {
	acquireUpdateAttributesLock,
	releaseUpdateAttributesLock,
	withUpdateAttributesLock,
	UPDATE_ATTRIBUTES_LOCK_TIMEOUT,
	UPDATE_ATTRIBUTES_LOCK_SLOW_WAIT,
} = require('#src/resources/Table');
const { logger } = require('#src/utility/logging/logger');
const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const TEST_DB = 'test';
const LOCK_KEY = 'update-attributes';

function openWorker() {
	return new Worker(__dirname + '/updateAttributesLock-thread.js', { workerData: { addPorts: [] } });
}

function request(workerThread, message, expectedType, hardTimeout) {
	return new Promise((resolve, reject) => {
		let timer;
		const settle = (finish) => {
			clearTimeout(timer);
			workerThread.off('message', onMessage);
			workerThread.off('error', onError);
			finish();
		};
		const onMessage = (result) => {
			if (result.type === expectedType) settle(() => resolve(result));
		};
		const onError = (error) => settle(() => reject(error));
		timer = setTimeout(
			() => settle(() => reject(new Error(`worker never answered '${message.type}' within ${hardTimeout}ms`))),
			hardTimeout
		);
		workerThread.on('message', onMessage);
		workerThread.on('error', onError);
		workerThread.postMessage(message);
	});
}

function runWorkerAction(message, expectedMessageTypes, hardTimeout) {
	return new Promise((resolve, reject) => {
		const workerThread = openWorker();
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
		const originalRemoveSync = PrimaryRocksDatabase.prototype.removeSync;
		let heldAtThrow;
		PrimaryRocksDatabase.prototype.removeSync = function () {
			heldAtThrow = !rootStore.tryLock(LOCK_KEY);
			if (!heldAtThrow) rootStore.unlock(LOCK_KEY);
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
		assert.strictEqual(heldAtThrow, true, 'the throw must escape from inside the locked region');
		assert.ok(rootStore.tryLock(LOCK_KEY), 'exclusive lock must not leak when table() throws');
		rootStore.unlock(LOCK_KEY);
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

	it('a real table() operation fails with ServerError after another thread wedges the lock for the full deadline', async function () {
		this.timeout(40000);
		const workerThread = openWorker();
		let wedged = false;
		let deadlineResult, updateResult;
		try {
			await request(workerThread, { type: 'prepare-deadline-table' }, 'deadline-table-prepared', 20000);
			wedged = rootStore.tryLock(LOCK_KEY);
			assert.ok(wedged, 'this thread should be able to wedge the lock the worker will wait on');
			deadlineResult = await request(workerThread, { type: 'declare-under-wedge' }, 'deadline-result', 30000);
			rootStore.unlock(LOCK_KEY);
			wedged = false;
			updateResult = await request(workerThread, { type: 'redeclare' }, 'table-updated', 20000);
			assert.ok(
				!deadlineResult.before.attributes.includes('added'),
				'test should start from the pre-declaration schema'
			);
			assert.deepStrictEqual(
				deadlineResult.after,
				deadlineResult.before,
				'a lock-acquire timeout must not leave that worker describing attributes it never persisted'
			);
		} finally {
			if (wedged) rootStore.unlock(LOCK_KEY);
			await workerThread.terminate();
		}
		assert.ok(deadlineResult.error, 'the wedged declaration should have thrown');
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
		assert.ok(updateResult.updated, `redeclaration should succeed once the lock is free: ${updateResult.error ?? ''}`);
		assert.ok(updateResult.applied.attributes.includes('added'), 'the retried declaration should apply the attribute');
		assert.ok(updateResult.applied.indices.includes('added'), 'the retried declaration should open the index');
	});

	it('warns exactly once when a successful acquisition waited past the slow-wait threshold', async function () {
		this.timeout(30000);
		const warnings = [];
		const originalWarn = Object.getOwnPropertyDescriptor(logger, 'warn');
		logger.warn = (message) => warnings.push(message);
		const workerThread = new Worker(__dirname + '/updateAttributesLock-thread.js', {
			workerData: { addPorts: [] },
		});
		try {
			withUpdateAttributesLock(rootStore, `table '${TEST_DB}.FastWait'`, () => 0);
			assert.strictEqual(warnings.length, 0, 'an uncontended acquisition must stay silent');
			const held = await new Promise((resolve, reject) => {
				workerThread.once('message', resolve);
				workerThread.once('error', reject);
				workerThread.postMessage({ type: 'hold-lock' });
			});
			assert.ok(held.acquired, 'worker thread should have taken the lock');
			workerThread.postMessage({ type: 'release-lock', holdTime: UPDATE_ATTRIBUTES_LOCK_SLOW_WAIT + 300 });
			acquireUpdateAttributesLock(rootStore, `table '${TEST_DB}.SlowWait'`);
			releaseUpdateAttributesLock(rootStore);
		} finally {
			if (originalWarn) Object.defineProperty(logger, 'warn', originalWarn);
			else delete logger.warn;
			await workerThread.terminate();
		}
		assert.strictEqual(warnings.length, 1, `expected one slow-wait warning, got ${warnings.length}`);
		assert.ok(warnings[0].includes(`table '${TEST_DB}.SlowWait'`), 'the warning should name the table in scope');
		assert.ok(/waiting \d+ms/.test(warnings[0]), 'the warning should report how long the acquisition waited');
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
			assert.ok(elapsed >= 200, `should wait for the holding thread, acquired after ${elapsed}ms`);
			assert.ok(elapsed < 5000, `should acquire promptly after release, took ${elapsed}ms`);
		} finally {
			await workerThread.terminate();
		}
	});
});
