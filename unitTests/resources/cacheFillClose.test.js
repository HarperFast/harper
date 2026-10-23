'use strict';

// A worker restart closes the thread's databases while a cache fill may still be waiting on its
// source. Closing the handle that owns a record lock releases it (rocksdb-js DBHandle::close ->
// lockReleaseByOwner; lmdb-js EnvWrap::closeEnv), so the fill's later unlock must be a no-op rather
// than a throw from its commit callback, and requests waiting on the lock must still settle.

require('../testUtils');
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table, getDatabases, closeDatabase } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { getRegistryStatus, RocksDatabase } = require('@harperfast/rocksdb-js');

describe('Cache fill across database close', function () {
	const isLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
	this.timeout(30_000);
	let databaseIndex = 0;
	let captured, savedRejectionListeners, savedExceptionListeners;
	const captureRejection = (reason) => captured.push(reason);
	const captureException = (error) => captured.push(error);

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	beforeEach(function () {
		captured = [];
		savedRejectionListeners = process.listeners('unhandledRejection');
		savedExceptionListeners = process.listeners('uncaughtException');
		process.removeAllListeners('unhandledRejection');
		process.removeAllListeners('uncaughtException');
		process.on('unhandledRejection', captureRejection);
		process.on('uncaughtException', captureException);
	});

	afterEach(function () {
		process.removeListener('unhandledRejection', captureRejection);
		process.removeListener('uncaughtException', captureException);
		for (const listener of savedRejectionListeners) process.on('unhandledRejection', listener);
		for (const listener of savedExceptionListeners) process.on('uncaughtException', listener);
	});

	// On RocksDB a second handle on the same path stands in for another thread: it keeps the shared
	// native descriptor (where record locks live) alive after this thread's handles close.
	function setUpSlowSourceTable() {
		const databaseName = `cache_fill_close_${databaseIndex++}`;
		const SlowTable = table({
			table: 'SlowSourced',
			database: databaseName,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		getDatabases();
		let releaseSource, failSource;
		const sourceGate = new Promise((resolve, reject) => {
			releaseSource = resolve;
			failSource = reject;
		});
		let sourceCalls = 0;
		SlowTable.sourcedFrom({
			async get(id) {
				sourceCalls++;
				await sourceGate;
				return { id, name: 'from source' };
			},
		});
		const path = SlowTable.primaryStore.rootStore.path;
		const otherThreadHandle = isLmdb ? undefined : new RocksDatabase(path).open();
		return {
			SlowTable,
			databaseName,
			releaseSource,
			failSource,
			otherThreadHandle,
			sourceCalls: () => sourceCalls,
			lockHeld: (id) => otherThreadHandle?.hasLock(id),
			registry: () => getRegistryStatus().find((entry) => entry.path === path),
		};
	}

	async function settleCallbacks() {
		for (let i = 0; i < 5; i++) await delay(10);
	}

	function capturedMessages() {
		return captured.map((error) => error?.message ?? String(error));
	}

	// RocksDB only: LMDB locks live in its environment, which this thread's close tears down.
	function assertRocksState(fixture, id, held) {
		if (isLmdb) return;
		assert.equal(fixture.lockHeld(id), held);
		assert.equal(fixture.registry().transactions, 0, 'no transaction handle is left open');
	}

	for (const sourceOutcome of ['resolves', 'rejects']) {
		it(`releases the record lock without throwing when the source ${sourceOutcome} after the database closes`, async function () {
			const fixture = setUpSlowSourceTable();
			const { SlowTable, databaseName, releaseSource, failSource, sourceCalls } = fixture;
			try {
				const fill = SlowTable.get('k1');
				while (sourceCalls() === 0) await delay(1);
				if (!isLmdb) assert.equal(fixture.lockHeld('k1'), true, 'the fill holds its lock while the source is pending');

				await closeDatabase(databaseName);
				if (!isLmdb) assert.equal(fixture.lockHeld('k1'), false, 'closing the handle releases its locks');

				if (sourceOutcome === 'resolves') {
					releaseSource();
					assert.equal((await fill)?.name, 'from source');
				} else {
					failSource(new Error('origin unavailable'));
					await assert.rejects(fill, /origin unavailable/);
				}
				await settleCallbacks();

				assert.deepEqual(capturedMessages(), []);
				assertRocksState(fixture, 'k1', false);
			} finally {
				fixture.otherThreadHandle?.close();
			}
		});
	}

	it('settles a request waiting on the fill lock when the database closes', async function () {
		const fixture = setUpSlowSourceTable();
		const { SlowTable, databaseName, releaseSource, sourceCalls } = fixture;
		try {
			const fill = SlowTable.get('k2');
			while (sourceCalls() === 0) await delay(1);
			// queues an unlock callback on the fill's lock instead of calling the source again
			const waiter = SlowTable.get('k2');
			await delay(5);
			assert.equal(sourceCalls(), 1);

			await closeDatabase(databaseName);
			// RocksDB: 'Database not open'; LMDB: 'Can not operate on a closed database'
			await assert.rejects(waiter, /Database not open|closed database/);
			releaseSource();
			assert.equal((await fill)?.name, 'from source');
			await settleCallbacks();

			assert.deepEqual(capturedMessages(), []);
			assertRocksState(fixture, 'k2', false);
		} finally {
			fixture.otherThreadHandle?.close();
		}
	});

	it('settles a request waiting on another thread’s lock after its own database closes', async function () {
		if (isLmdb) this.skip();
		const { SlowTable, databaseName, otherThreadHandle, sourceCalls } = setUpSlowSourceTable();
		try {
			assert.equal(otherThreadHandle.tryLock('k3'), true);
			const waiter = SlowTable.get('k3');
			await delay(5);
			assert.equal(sourceCalls(), 0, 'the request waits on the other handle’s lock');

			// the other handle's lock survives this close, so only the wait timeout can settle the request
			await closeDatabase(databaseName);
			await assert.rejects(waiter, /Database not open/);
			await settleCallbacks();

			assert.deepEqual(capturedMessages(), []);
			assert.equal(otherThreadHandle.hasLock('k3'), true, 'a closed handle cannot release another handle’s lock');
			otherThreadHandle.unlock('k3');
			await settleCallbacks();
			assert.deepEqual(capturedMessages(), [], 'a late unlock notification is harmless');
		} finally {
			otherThreadHandle.close();
		}
	});
});
