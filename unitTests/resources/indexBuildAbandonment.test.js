/**
 * harper#2537 / harper#2536. A backfill can end without running either of runIndexing's own exit paths
 * — the restart-interrupt return inside the loop, and the closed-store return in its catch — leaving a
 * descriptor that claims an armed, in-progress build with no `indexingFailed`, nothing logged above
 * debug, and nothing to re-trigger it. Both reach the same settle handler; the cases below simulate
 * the closed-store return, which is the one reproducible without a live worker generation. Two guards
 * cover that:
 *
 *   1. the operation's settle handler persists the failure marker for the exact build it scheduled;
 *   2. the trigger treats a build whose process incarnation is not this process's — including a
 *      descriptor written before that field existed — as abandoned, which is the only way to detect a
 *      process restart when Harper is PID 1 and the restart generation resets to 1 in memory.
 */

require('../testUtils');
const assert = require('node:assert');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { setupTestDBPath } = require('../testUtils');
const { table, tryAcquireUpdateAttributesLock } = require('#src/resources/databases');
const manageThreads = require('#js/server/threads/manageThreads');
const { forComponent } = require('#src/utility/logging/harper_logger');

// raw ASCII bytes are ordered-binary's encoding of the string databases.ts locks on, so this
// addresses the same native lock
const UPDATE_ATTRIBUTES_LOCK_KEY = Buffer.from('update-attributes');

describe('an index build that ends without completing is marked and recovered', function () {
	this.timeout(60000);

	before(() => {
		setupTestDBPath();
		manageThreads.setMainIsWorker(true);
	});

	async function catalogFlushed(Table) {
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
	}

	function seed(tableName, indexed) {
		const Table = table({
			table: tableName,
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'tag', type: 'String', indexed },
			],
		});
		return Table;
	}

	it('persists a failure marker when the backfill returns through its silent store-shutdown path', async () => {
		const tableName = 'IndexAbandonShutdown';
		const Seeded = seed(tableName, false);
		let lastPut;
		for (let i = 0; i < 10; i++) lastPut = Seeded.put({ id: `k-${i}`, tag: i % 2 ? 'odd' : 'even' });
		await lastPut;

		const storageLogger = forComponent('storage');
		const originalWarn = storageLogger.warn;
		const warnings = [];
		storageLogger.warn = (...args) => warnings.push(args);

		// table() reads the primary store to decide there is data to backfill, so the interruption is
		// installed only once it has returned — runIndexing suspends at its first await before iterating.
		const Rebuilding = seed(tableName, true);
		const primaryStore = Rebuilding.primaryStore;
		const rootStore = primaryStore.rootStore;
		const originalGetRange = primaryStore.getRange;
		const originalStatus = Object.getOwnPropertyDescriptor(rootStore, 'status');
		primaryStore.getRange = () => {
			throw new Error('Database not open');
		};
		Object.defineProperty(rootStore, 'status', { value: 'closed', configurable: true, writable: true });
		try {
			await Rebuilding.indexingOperation;
		} finally {
			primaryStore.getRange = originalGetRange;
			if (originalStatus) Object.defineProperty(rootStore, 'status', originalStatus);
			else delete rootStore.status;
			storageLogger.warn = originalWarn;
		}

		await catalogFlushed(Rebuilding);
		const descriptor = Rebuilding.dbisDB.getSync(`${tableName}/tag`);
		assert.strictEqual(
			descriptor.indexingFailed,
			true,
			'a backfill that returned without completing must leave a durable failure marker, or nothing re-triggers it'
		);
		assert.ok(descriptor.indexingPID, 'the build must still read as incomplete so queries keep refusing');
		assert.strictEqual(
			Rebuilding.indices.tag.isIndexing,
			true,
			'the index must stay marked as rebuilding after an abandoned build'
		);
		const reported = warnings
			.map(([message]) => message)
			.filter((message) => typeof message === 'string' && message.includes(`${tableName}.tag`));
		assert.strictEqual(
			reported.length,
			1,
			`the abandoned build must be reported above debug: ${JSON.stringify(warnings)}`
		);

		const Recovered = seed(tableName, true);
		assert.ok(Recovered.indexingOperation, 'the persisted marker must re-trigger the backfill on the next load');
		await Recovered.indexingOperation;
		await catalogFlushed(Recovered);
		assert.strictEqual(
			Recovered.dbisDB.getSync(`${tableName}/tag`).indexingPID,
			undefined,
			'the recovered build must complete and clear the descriptor'
		);
		assert.strictEqual(Recovered.indices.tag.isIndexing, false, 'the recovered index must be usable again');
	});

	it('does not mark a build a replacement claimed between the settle handler check and its write', async () => {
		const tableName = 'IndexAbandonNotOwned';
		const key = `${tableName}/tag`;
		const Seeded = seed(tableName, false);
		let lastPut;
		for (let i = 0; i < 10; i++) lastPut = Seeded.put({ id: `k-${i}`, tag: i % 2 ? 'odd' : 'even' });
		await lastPut;

		const Rebuilding = seed(tableName, true);
		const ownBuildId = Rebuilding.dbisDB.getSync(key).indexingBuildId;
		assert.ok(ownBuildId, 'the trigger must stamp a build id for the settle handler to fence on');

		// The settle handler re-reads under the exclusive catalog lock; report a replacement's claim on
		// that read, which is the window a replacement worker generation actually claims the build in.
		const dbisDB = Rebuilding.dbisDB;
		const rootStore = Rebuilding.primaryStore.rootStore;
		const isRocksDatabase = rootStore instanceof RocksDatabase;
		const originalGetSync = dbisDB.getSync.bind(dbisDB);
		const originalTransactionSync = rootStore.transactionSync;
		let reads = 0;
		let heldOnReread = null;
		if (!isRocksDatabase) {
			rootStore.transactionSync = function (...args) {
				heldOnReread = true;
				return originalTransactionSync.apply(this, args);
			};
		}
		dbisDB.getSync = (readKey, ...rest) => {
			const value = originalGetSync(readKey, ...rest);
			if (readKey === key && ++reads === 2) {
				// tryLock fails even for the thread already holding it, so this observes the locked section
				if (isRocksDatabase) {
					heldOnReread = !rootStore.tryLock(UPDATE_ATTRIBUTES_LOCK_KEY);
					if (!heldOnReread) rootStore.unlock(UPDATE_ATTRIBUTES_LOCK_KEY);
				}
				return { ...value, indexingBuildId: 'a-replacement-build' };
			}
			return value;
		};
		const originalStatus = Object.getOwnPropertyDescriptor(rootStore, 'status');
		const originalGetRange = Rebuilding.primaryStore.getRange;
		Rebuilding.primaryStore.getRange = () => {
			throw new Error('Database not open');
		};
		Object.defineProperty(rootStore, 'status', { value: 'closed', configurable: true, writable: true });
		try {
			await Rebuilding.indexingOperation;
		} finally {
			Rebuilding.primaryStore.getRange = originalGetRange;
			if (originalStatus) Object.defineProperty(rootStore, 'status', originalStatus);
			else delete rootStore.status;
			dbisDB.getSync = originalGetSync;
			if (!isRocksDatabase) rootStore.transactionSync = originalTransactionSync;
		}

		assert.ok(reads >= 2, 'the settle handler must re-read the descriptor after its first check');
		assert.strictEqual(
			heldOnReread,
			true,
			'the re-read and the write must happen under the exclusive catalog lock the declaration takes'
		);
		await catalogFlushed(Rebuilding);
		assert.strictEqual(
			originalGetSync(key).indexingFailed,
			undefined,
			'the settle handler marked a build that a replacement had already claimed'
		);
		assert.strictEqual(
			originalGetSync(key).indexingBuildId,
			ownBuildId,
			'the settle handler must not write its own stale descriptor snapshot back over the catalog'
		);
	});

	it('aborts the LMDB catalog transaction when persisting the failure marker throws', async function () {
		if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') this.skip();
		const tableName = 'IndexAbandonMarkerAbort';
		const key = `${tableName}/tag`;
		const Seeded = seed(tableName, false);
		let lastPut;
		for (let i = 0; i < 10; i++) lastPut = Seeded.put({ id: `k-${i}`, tag: i % 2 ? 'odd' : 'even' });
		await lastPut;

		const Rebuilding = seed(tableName, true);
		const dbisDB = Rebuilding.dbisDB;
		const originalPut = dbisDB.put;
		const originalPutSync = dbisDB.putSync;
		function throwAfterMarkerWrite(write) {
			return function (writeKey, value, ...rest) {
				const result = write.call(this, writeKey, value, ...rest);
				if (writeKey === key && value?.indexingFailed) throw new Error('marker write failed after staging');
				return result;
			};
		}
		dbisDB.put = throwAfterMarkerWrite(originalPut);
		dbisDB.putSync = throwAfterMarkerWrite(originalPutSync);
		const rootStore = Rebuilding.primaryStore.rootStore;
		const originalStatus = Object.getOwnPropertyDescriptor(rootStore, 'status');
		const originalGetRange = Rebuilding.primaryStore.getRange;
		Rebuilding.primaryStore.getRange = () => {
			throw new Error('Database not open');
		};
		Object.defineProperty(rootStore, 'status', { value: 'closed', configurable: true, writable: true });
		try {
			await Rebuilding.indexingOperation;
		} finally {
			Rebuilding.primaryStore.getRange = originalGetRange;
			if (originalStatus) Object.defineProperty(rootStore, 'status', originalStatus);
			else delete rootStore.status;
			dbisDB.put = originalPut;
			dbisDB.putSync = originalPutSync;
		}

		assert.strictEqual(
			dbisDB.getSync(key).indexingFailed,
			undefined,
			'a failed marker write must abort instead of committing its staged catalog change'
		);
	});

	it('re-triggers a build whose process incarnation is not this process, including one that has none', async () => {
		const tableName = 'IndexAbandonIncarnation';
		const Seeded = seed(tableName, true);
		let lastPut;
		for (let i = 0; i < 10; i++) lastPut = Seeded.put({ id: `k-${i}`, tag: i % 2 ? 'odd' : 'even' });
		await lastPut;
		if (Seeded.indexingOperation) await Seeded.indexingOperation;
		await catalogFlushed(Seeded);
		const completedBuild = Seeded.indexingOperation;
		const key = `${tableName}/tag`;
		const complete = Seeded.dbisDB.getSync(key);

		// Both shapes a container restart leaves behind: the PID is reused (Harper is PID 1) and the
		// in-memory restart generation is back to its starting value, so neither existing check fires.
		for (const [label, incarnation] of [
			['written by an older version, with no incarnation at all', undefined],
			['written by a previous incarnation of this same PID', 'not-this-process'],
		]) {
			const armed = {
				...complete,
				indexingPID: process.pid,
				restartNumber: manageThreads.restartNumber ?? 1,
				lastIndexedKey: 'k-4',
			};
			if (incarnation === undefined) delete armed.indexingIncarnation;
			else armed.indexingIncarnation = incarnation;
			const written = Seeded.dbisDB.put(key, armed);
			if (written?.then) await written;

			const Recovered = seed(tableName, true);
			assert.notStrictEqual(
				Recovered.indexingOperation,
				completedBuild,
				`an armed build ${label} must be re-triggered, not trusted`
			);
			await Recovered.indexingOperation;
			await catalogFlushed(Recovered);
			assert.strictEqual(
				Recovered.dbisDB.getSync(key).indexingPID,
				undefined,
				`the recovered build (${label}) must complete and clear the descriptor`
			);
			assert.strictEqual(Recovered.indices.tag.isIndexing, false, `the recovered index (${label}) must be usable`);
			const odds = [];
			for await (const record of Recovered.search({ conditions: [{ attribute: 'tag', value: 'odd' }] }))
				odds.push(record);
			assert.strictEqual(odds.length, 5, `the recovered backfill (${label}) must index every record`);
		}
	});

	it('leaves a build owned by this process incarnation alone', async () => {
		const tableName = 'IndexAbandonLive';
		const Seeded = seed(tableName, true);
		let lastPut;
		for (let i = 0; i < 10; i++) lastPut = Seeded.put({ id: `k-${i}`, tag: i % 2 ? 'odd' : 'even' });
		await lastPut;
		if (Seeded.indexingOperation) await Seeded.indexingOperation;
		await catalogFlushed(Seeded);
		const completedBuild = Seeded.indexingOperation;

		// A second thread of this process declaring the same table while the build is genuinely in flight
		// must not start a duplicate backfill.
		const key = `${tableName}/tag`;
		const written = Seeded.dbisDB.put(key, {
			...Seeded.dbisDB.getSync(key),
			indexingPID: process.pid,
			restartNumber: manageThreads.restartNumber ?? 1,
			indexingIncarnation: manageThreads.processIncarnation,
			lastIndexedKey: 'k-4',
		});
		if (written?.then) await written;

		const Live = seed(tableName, true);
		assert.strictEqual(Live.indexingOperation, completedBuild, 'a live build in this process must not be re-triggered');
		assert.strictEqual(Live.indices.tag.isIndexing, true, 'a live build must still read as incomplete');
	});

	// v5.2 only: main takes this lock through resources/Table.ts's acquireUpdateAttributesLock, which
	// throws on timeout. That helper does not exist here, so the marker path has its own bounded
	// acquire — the cost of giving up is one skipped marker, and the next load re-triggers the build.
	describe('the marker path gives up on the attribute lock rather than spinning forever', () => {
		it('returns false once the timeout elapses, without throwing', () => {
			let attempts = 0;
			const neverAvailable = {
				tryLock() {
					attempts++;
					return false;
				},
			};
			const startTime = performance.now();
			assert.strictEqual(tryAcquireUpdateAttributesLock(neverAvailable, 50), false);
			const elapsed = performance.now() - startTime;
			assert.ok(elapsed >= 50, `must wait out the timeout, waited ${Math.round(elapsed)}ms`);
			assert.ok(elapsed < 2000, `must not overshoot the timeout, waited ${Math.round(elapsed)}ms`);
			assert.ok(attempts > 1, 'must retry rather than give up on the first refusal');
		});

		it('acquires as soon as the holder releases', () => {
			let refusalsLeft = 3;
			const releasedShortly = { tryLock: () => refusalsLeft-- <= 0 };
			assert.strictEqual(tryAcquireUpdateAttributesLock(releasedShortly, 5000), true);
		});

		it('takes an uncontended lock without waiting at all', () => {
			let attempts = 0;
			const free = {
				tryLock() {
					attempts++;
					return true;
				},
			};
			assert.strictEqual(tryAcquireUpdateAttributesLock(free), true);
			assert.strictEqual(attempts, 1, 'the uncontended path must not enter the wait loop');
		});
	});
});
