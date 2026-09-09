/**
 * harper#2537 / harper#2536. A backfill can end without running either of runIndexing's own exit paths
 * — the restart-interrupt return inside the loop, and the closed-store return in its catch — leaving a
 * descriptor that claims an armed, in-progress build with no `indexingFailed`, nothing logged above
 * debug, and nothing to re-trigger it. Two guards cover that:
 *
 *   1. the operation's settle handler persists the failure marker for the exact build it scheduled;
 *   2. the trigger treats a build whose process incarnation is not this process's — including a
 *      descriptor written before that field existed — as abandoned, which is the only way to detect a
 *      process restart when Harper is PID 1 and the restart generation resets to 1 in memory.
 */

require('../testUtils');
const assert = require('node:assert/strict');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const manageThreads = require('#js/server/threads/manageThreads');
const { forComponent } = require('#src/utility/logging/harper_logger');

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
		assert.equal(
			descriptor.indexingFailed,
			true,
			'a backfill that returned without completing must leave a durable failure marker, or nothing re-triggers it'
		);
		assert.ok(descriptor.indexingPID, 'the build must still read as incomplete so queries keep refusing');
		assert.equal(
			Rebuilding.indices.tag.isIndexing,
			true,
			'the index must stay marked as rebuilding after an abandoned build'
		);
		const reported = warnings
			.map(([message]) => message)
			.filter((message) => typeof message === 'string' && message.includes(`${tableName}.tag`));
		assert.equal(reported.length, 1, `the abandoned build must be reported above debug: ${JSON.stringify(warnings)}`);

		// The marker is what the next load acts on.
		const Recovered = seed(tableName, true);
		assert.ok(Recovered.indexingOperation, 'the persisted marker must re-trigger the backfill on the next load');
		await Recovered.indexingOperation;
		await catalogFlushed(Recovered);
		assert.equal(
			Recovered.dbisDB.getSync(`${tableName}/tag`).indexingPID,
			undefined,
			'the recovered build must complete and clear the descriptor'
		);
		assert.equal(Recovered.indices.tag.isIndexing, false, 'the recovered index must be usable again');
	});

	it('does not mark a build the settle handler no longer owns', async () => {
		const tableName = 'IndexAbandonNotOwned';
		const Seeded = seed(tableName, true);
		let lastPut;
		for (let i = 0; i < 10; i++) lastPut = Seeded.put({ id: `k-${i}`, tag: i % 2 ? 'odd' : 'even' });
		await lastPut;
		if (Seeded.indexingOperation) await Seeded.indexingOperation;
		await catalogFlushed(Seeded);

		// A descriptor re-armed by a later owner, exactly as a replacement worker generation would leave
		// it: the settled handler must not write a failure marker over a build that is not its own.
		const key = `${tableName}/tag`;
		const descriptor = Seeded.dbisDB.getSync(key);
		const written = Seeded.dbisDB.put(key, {
			...descriptor,
			indexingPID: process.pid,
			restartNumber: (manageThreads.restartNumber ?? 1) + 1,
			indexingIncarnation: manageThreads.processIncarnation,
		});
		if (written?.then) await written;

		await Seeded.indexingOperation;
		await catalogFlushed(Seeded);
		assert.equal(
			Seeded.dbisDB.getSync(key).indexingFailed,
			undefined,
			'the settle handler marked a build owned by a newer generation as failed'
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
			assert.notEqual(
				Recovered.indexingOperation,
				completedBuild,
				`an armed build ${label} must be re-triggered, not trusted`
			);
			await Recovered.indexingOperation;
			await catalogFlushed(Recovered);
			assert.equal(
				Recovered.dbisDB.getSync(key).indexingPID,
				undefined,
				`the recovered build (${label}) must complete and clear the descriptor`
			);
			assert.equal(Recovered.indices.tag.isIndexing, false, `the recovered index (${label}) must be usable`);
			const odds = [];
			for await (const record of Recovered.search({ conditions: [{ attribute: 'tag', value: 'odd' }] }))
				odds.push(record);
			assert.equal(odds.length, 5, `the recovered backfill (${label}) must index every record`);
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
		assert.equal(Live.indexingOperation, completedBuild, 'a live build in this process must not be re-triggered');
		assert.equal(Live.indices.tag.isIndexing, true, 'a live build must still read as incomplete');
	});
});
