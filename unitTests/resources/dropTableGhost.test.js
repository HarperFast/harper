require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table, database, databases, getDatabases, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const harperLogger = require('#src/utility/logging/harper_logger');

const TEST_DB = 'test';

function defineTable(name) {
	return table({
		table: name,
		database: TEST_DB,
		attributes: [
			{ name: 'id', type: 'Int', isPrimaryKey: true },
			{ name: 'str', type: 'String' },
		],
	});
}

function getDbisDb() {
	return database({ database: TEST_DB, table: null }).dbisDb;
}

// dropTable drops column families with dropSync() on RocksDB (under the
// exclusive lock) and with the awaited drop() on LMDB, so stub both to make a
// test engine-agnostic under `test:unit` and `test:unit:lmdb`. Returns a
// restore function.
function stubFailingDrop(store, error) {
	const original = { drop: store.drop, dropSync: store.dropSync };
	store.dropSync = () => {
		throw error;
	};
	store.drop = () => Promise.reject(error);
	return () => Object.assign(store, original);
}

describe('dropTable ghost regression', () => {
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('drops and recreates a table with the same name in-process', async function () {
		const First = defineTable('GhostSameName');
		await First.put({ id: 1, str: 'original' });
		await First.dropTable();
		const Second = defineTable('GhostSameName');
		await Second.put({ id: 2, str: 'recreated' });
		assert.equal((await Second.get(2)).str, 'recreated');
		// the dropped table's data must not leak into the new store
		assert.equal(await Second.get(1), undefined);
		await Second.dropTable();
	});

	it('completes an interrupted drop at load instead of resurrecting the table', async function () {
		const Zombie = defineTable('GhostZombie');
		await Zombie.put({ id: 1, str: 'alive' });
		// simulate a drop that died right after persisting its tombstone
		const dbisDb = getDbisDb();
		const meta = dbisDb.getSync('GhostZombie/');
		assert.ok(meta, 'catalog entry should exist before the simulated interruption');
		meta.dropping = true;
		await dbisDb.put('GhostZombie/', meta);
		delete databases[TEST_DB].GhostZombie;

		resetDatabases();
		const reloaded = getDatabases();

		assert.equal(reloaded[TEST_DB]?.GhostZombie, undefined, 'tombstoned table must not load');
		assert.equal(getDbisDb().getSync('GhostZombie/'), undefined, 'catalog rows must be removed');
	});

	it('creating over a tombstoned entry completes the drop and creates fresh', async function () {
		this.timeout(10000); // regression: this used to recurse forever
		const Doomed = defineTable('GhostCreateOver');
		await Doomed.put({ id: 7, str: 'old' });
		const dbisDb = getDbisDb();
		const meta = dbisDb.getSync('GhostCreateOver/');
		meta.dropping = true;
		await dbisDb.put('GhostCreateOver/', meta);
		delete databases[TEST_DB].GhostCreateOver;

		const Fresh = defineTable('GhostCreateOver');
		await Fresh.put({ id: 8, str: 'new' });
		assert.equal((await Fresh.get(8)).str, 'new');
		assert.equal(await Fresh.get(7), undefined, 'old data must not resurrect');
		await Fresh.dropTable();
	});

	it('surfaces a failed column family drop and completes the drop on recreate', async function () {
		const Doomed = defineTable('GhostFailDrop');
		await Doomed.put({ id: 1, str: 'data' });
		const restore = stubFailingDrop(Doomed.primaryStore, new Error('injected drop failure'));
		try {
			await assert.rejects(() => Doomed.dropTable(), /injected drop failure/);
		} finally {
			restore();
		}
		// the table is gone from the live schema (no half-alive table)...
		assert.equal(databases[TEST_DB]?.GhostFailDrop, undefined, 'failed drop must still remove the table from memory');
		// ...but the tombstoned catalog entry survives so the drop can complete later
		assert.equal(getDbisDb().getSync('GhostFailDrop/')?.dropping, true, 'tombstone must survive a failed drop');

		// recreating the same name completes the interrupted drop and works
		const Fresh = defineTable('GhostFailDrop');
		await Fresh.put({ id: 2, str: 'fresh' });
		assert.equal((await Fresh.get(2)).str, 'fresh');
		assert.equal(await Fresh.get(1), undefined, 'old data must not resurrect');
		await Fresh.dropTable();
	});

	it('tolerates an already-dropped column family and completes the drop', async function () {
		const Raced = defineTable('GhostAlreadyDropped');
		await Raced.put({ id: 1, str: 'data' });
		// A concurrent worker already dropped the shared column family (drops are
		// broadcast to every thread), so the storage engine reports the redundant
		// drop as "Column family already dropped!". The family being gone is the
		// intended outcome, so the drop operation must succeed rather than fail.
		const restore = stubFailingDrop(Raced.primaryStore, new Error('Invalid argument: Column family already dropped!'));
		try {
			await Raced.dropTable();
		} finally {
			restore();
		}
		// the table is removed from the live schema...
		assert.equal(
			databases[TEST_DB]?.GhostAlreadyDropped,
			undefined,
			'tolerated drop must remove the table from memory'
		);
		// ...and because the drop is treated as success, the catalog rows (and any
		// tombstone) are removed too - no ghost left behind for the reconcile.
		assert.equal(
			getDbisDb().getSync('GhostAlreadyDropped/'),
			undefined,
			'catalog rows must be removed on a tolerated drop'
		);
	});

	it('does not clobber a same-name table created during a tolerated drop race', async function () {
		// Exercises the RocksDB drop path (synchronous dropSync under the exclusive
		// lock) and its tombstone-guarded catalog removal; the LMDB path keeps the
		// awaited drop() and is covered by the create-over-tombstone case above.
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const Raced = defineTable('GhostDropRaceCreate');
		await Raced.put({ id: 1, str: 'data' });
		const dbisDb = getDbisDb();
		const originalDrop = Raced.primaryStore.dropSync;
		// Simulate the race: while this drop holds the lock, the catalog already
		// carries a fresh, non-tombstoned row for a same-name table (as a concurrent
		// create's completeInterruptedDrop would have left it). The guard must see
		// the fresh row on its re-read and skip removal so it is not clobbered.
		Raced.primaryStore.dropSync = () => {
			const fresh = { ...dbisDb.getSync('GhostDropRaceCreate/') };
			delete fresh.dropping;
			dbisDb.putSync('GhostDropRaceCreate/', fresh);
			throw new Error('Column family already dropped!');
		};
		try {
			await Raced.dropTable();
		} finally {
			Raced.primaryStore.dropSync = originalDrop;
		}
		// the new table's catalog row must survive - cleanup only runs when this
		// drop's own tombstone is still the live primary row
		const survived = dbisDb.getSync('GhostDropRaceCreate/');
		assert.ok(survived, 'a same-name table created during the drop must keep its catalog row');
		assert.ok(!survived.dropping, 'the surviving row must be the fresh (non-tombstoned) create');
	});

	it('bounds the retries of a drop that can never complete', async function () {
		this.timeout(20000);
		// The attempt budget is module-level and deliberately survives until the
		// process restarts, so a fixed name would start this test with a spent
		// budget on any in-process re-run (a mocha retry, say).
		const TABLE = `GhostRetryBound_${process.pid}_${Date.now()}`;
		const Stuck = defineTable(TABLE);
		await Stuck.put({ id: 1, str: 'data' });
		const dbisDb = getDbisDb();
		const meta = dbisDb.getSync(`${TABLE}/`);
		meta.dropping = true;
		await dbisDb.put(`${TABLE}/`, meta);
		delete databases[TEST_DB][TABLE];

		// completeInterruptedDrop finishes by removing the table's catalog rows via
		// removeSync. Fail that the way a storage environment that can no longer
		// accept writes does, so every completion attempt fails identically and
		// forever.
		const originalRemoveSync = dbisDb.removeSync;
		let attempts = 0;
		dbisDb.removeSync = function (key, ...rest) {
			if (typeof key === 'string' && key.startsWith(`${TABLE}/`)) {
				attempts++;
				throw new Error('Remove failed: Invalid argument: Invalid column family specified in write batch');
			}
			return originalRemoveSync.call(this, key, ...rest);
		};
		const storageLogger = harperLogger.forComponent('storage');
		const originalLogError = storageLogger.error;
		const errorLogs = [];
		storageLogger.error = (message, ...rest) => {
			errorLogs.push(message);
			return originalLogError.call(storageLogger, message, ...rest);
		};

		const reload = () => {
			resetDatabases();
			getDatabases();
		};
		let attemptsWhenExhausted = 0;
		try {
			for (let i = 0; i < 5; i++) reload();
			attemptsWhenExhausted = attempts;
			for (let i = 0; i < 5; i++) reload();
		} finally {
			storageLogger.error = originalLogError;
			dbisDb.removeSync = originalRemoveSync;
		}

		assert.ok(attemptsWhenExhausted > 0, 'the interrupted drop must be attempted at least once');
		assert.equal(
			attempts,
			attemptsWhenExhausted,
			`completion attempts must stop, not repeat on every schema reload (${attempts - attemptsWhenExhausted} more over 5 further reloads)`
		);

		// setupTestDBPath() mirrors this store's tombstone into every database
		// alias that shares its physical path (data/dev/test/test2), and the
		// reconcile runs once per alias per reload - but the retry budget is
		// keyed on the physical store path, not the alias name, so all four
		// aliases share one budget and this physically-one table gives up
		// exactly once total, under whichever alias's reconcile pass happened
		// to be the one that spent the last attempt.
		const giveUpLogs = errorLogs.filter((message) => String(message).includes(TABLE));
		const loggedTables = giveUpLogs.map((message) => String(message).match(/table (\S+)/)[1]);
		assert.equal(
			loggedTables.length,
			1,
			`a table shared by every database alias must give up exactly once total, got: ${loggedTables.join(', ')}`
		);
		assert.ok(loggedTables[0].endsWith(`.${TABLE}`), 'the stuck table must be named in the error');
		assert.match(giveUpLogs[0], /giving up until this worker restarts/);
		// the table must stay unloaded regardless
		assert.equal(getDatabases()[TEST_DB]?.[TABLE], undefined, 'a tombstoned table must never load');

		// the budget is exhausted for this process, so clean the tombstoned rows up
		// by hand rather than leaving a stuck table behind for later tests
		for (const key of [...dbisDb.getKeys({ start: `${TABLE}/`, end: `${TABLE}0` })]) {
			dbisDb.remove(key);
		}
		await dbisDb.committed;
	});

	it('only logs the give-up error from worker 0, not every worker', async function () {
		this.timeout(20000);
		// Every worker thread tracks its own budget and independently exhausts it,
		// so without a single-worker gate this would log once per worker instead
		// of once for the whole process. Uses two tables (one exhausted as a
		// non-worker-0 thread, one as worker 0) because a table's budget only
		// logs once, at the reload where it first hits MAX_INTERRUPTED_DROP_ATTEMPTS
		// - re-observing an already-exhausted table from worker 0 does not re-log.
		//
		// table() reassigns rootStore.dbisDb to a fresh openDB() result on every
		// create, so dbisDb must be (re-)fetched after a table is defined, not
		// before - an earlier reference goes stale the moment the next table is
		// created and stubbing it has no effect on the reconcile's real attributesDbi.
		const stuckTombstone = async (table) => {
			const Stuck = defineTable(table);
			await Stuck.put({ id: 1, str: 'data' });
			const dbisDb = getDbisDb();
			const meta = dbisDb.getSync(`${table}/`);
			meta.dropping = true;
			await dbisDb.put(`${table}/`, meta);
			delete databases[TEST_DB][table];
			return dbisDb;
		};
		const stubFailingRemove = (dbisDb, table) => {
			const originalRemoveSync = dbisDb.removeSync;
			dbisDb.removeSync = function (key, ...rest) {
				if (typeof key === 'string' && key.startsWith(`${table}/`)) {
					throw new Error('Remove failed: Invalid argument: Invalid column family specified in write batch');
				}
				return originalRemoveSync.call(this, key, ...rest);
			};
			return () => {
				dbisDb.removeSync = originalRemoveSync;
			};
		};
		const storageLogger = harperLogger.forComponent('storage');
		const originalLogError = storageLogger.error;
		const errorLogs = [];
		storageLogger.error = (message, ...rest) => {
			errorLogs.push(message);
			return originalLogError.call(storageLogger, message, ...rest);
		};
		const reload = () => {
			resetDatabases();
			getDatabases();
		};
		const cleanUpTombstone = (dbisDb, table) => {
			for (const key of [...dbisDb.getKeys({ start: `${table}/`, end: `${table}0` })]) {
				dbisDb.remove(key);
			}
		};

		const OTHER_WORKER_TABLE = `GhostWorkerGateOther_${process.pid}_${Date.now()}`;
		const WORKER_ZERO_TABLE = `GhostWorkerGateZero_${process.pid}_${Date.now()}`;
		try {
			// exhaust the non-worker-0 table's budget entirely off-gate
			let dbisDb = await stuckTombstone(OTHER_WORKER_TABLE);
			let restoreRemove = stubFailingRemove(dbisDb, OTHER_WORKER_TABLE);
			setMainIsWorker(false);
			for (let i = 0; i < 5; i++) reload();
			restoreRemove();
			assert.equal(
				errorLogs.filter((message) => String(message).includes(OTHER_WORKER_TABLE)).length,
				0,
				'a non-worker-0 thread must not log the give-up error'
			);
			cleanUpTombstone(dbisDb, OTHER_WORKER_TABLE);

			// a fresh table's budget, exhausted on-gate, must log exactly once - this
			// must be a separate table since the first one's budget is already spent
			// and would no longer be retried (so re-observing it under worker 0
			// would not exercise the gate at all)
			dbisDb = await stuckTombstone(WORKER_ZERO_TABLE);
			restoreRemove = stubFailingRemove(dbisDb, WORKER_ZERO_TABLE);
			setMainIsWorker(true);
			for (let i = 0; i < 5; i++) reload();
			restoreRemove();
			// setupTestDBPath() points data/dev/test/test2 at the same physical
			// path, so this table's tombstone is reconciled once per database
			// alias per reload - but the retry budget is keyed on the physical
			// store path (see interruptedDropKey), not the alias name, so all
			// four aliases' reconcile passes share one budget and this table
			// still gives up exactly once total, regardless of which alias's
			// pass happens to be the one that trips the gate.
			assert.equal(
				errorLogs.filter((message) => String(message).includes(WORKER_ZERO_TABLE)).length,
				1,
				`worker 0 must log the give-up error exactly once across all database aliases, got: ${errorLogs.join(' | ')}`
			);
			cleanUpTombstone(dbisDb, WORKER_ZERO_TABLE);
			await dbisDb.committed;
		} finally {
			storageLogger.error = originalLogError;
			setMainIsWorker(true);
		}
	});

	// A spent budget must not outlive the drop that spent it. The create path
	// completes interrupted drops itself, under the exclusive lock, and never
	// passes through the reconcile - so a table can go from "budget exhausted" to
	// "alive again" without the reconcile ever seeing a success. If the budget
	// survived that, the table's NEXT interrupted drop would be skipped outright
	// and its catalog rows would silently resurrect it.
	it('clears a spent retry budget once the table is no longer tombstoned', async function () {
		this.timeout(20000);
		const TABLE = `GhostBudgetReset_${process.pid}_${Date.now()}`;
		const Stuck = defineTable(TABLE);
		await Stuck.put({ id: 1, str: 'data' });
		const dbisDb = getDbisDb();

		const setDropping = async (dropping) => {
			const meta = dbisDb.getSync(`${TABLE}/`);
			meta.dropping = dropping;
			await dbisDb.put(`${TABLE}/`, meta);
		};

		const originalRemoveSync = dbisDb.removeSync;
		let attempts = 0;
		dbisDb.removeSync = function (key, ...rest) {
			if (typeof key === 'string' && key.startsWith(`${TABLE}/`)) {
				attempts++;
				throw new Error('Remove failed: Invalid argument: Invalid column family specified in write batch');
			}
			return originalRemoveSync.call(this, key, ...rest);
		};
		const reload = () => {
			resetDatabases();
			getDatabases();
		};

		try {
			// spend the whole budget on a first interrupted drop
			await setDropping(true);
			delete databases[TEST_DB][TABLE];
			for (let i = 0; i < 5; i++) reload();
			const spent = attempts;
			assert.ok(spent > 0, 'the first interrupted drop must be attempted');

			// the drop is resolved elsewhere (the create path) and the table lives
			// again: one reload with no tombstone must return the budget
			await setDropping(false);
			reload();

			// a second interrupted drop must get a fresh budget, not the spent one
			await setDropping(true);
			delete databases[TEST_DB][TABLE];
			reload();
			assert.ok(
				attempts > spent,
				`a later interrupted drop must be retried again, not skipped on the previous drop's spent budget (attempts stuck at ${attempts})`
			);
		} finally {
			dbisDb.removeSync = originalRemoveSync;
		}

		for (const key of [...dbisDb.getKeys({ start: `${TABLE}/`, end: `${TABLE}0` })]) {
			dbisDb.remove(key);
		}
		await dbisDb.committed;
	});

	// PR review (kriszyp): the reset above depends on this worker observing an
	// intermediate non-tombstoned row between two drops. A worker can exhaust
	// drop A's budget, then never see A's catalog removal - because some other
	// worker/process completed it and immediately recreated + re-dropped the
	// table as drop B - before this worker's next reload. Without a per-drop
	// identity, that reload would see only B's tombstone with A's spent count
	// and skip every cleanup attempt for B. The budget is now keyed by the
	// tombstone's own dropGeneration (stamped fresh by Table.ts on every drop),
	// so B's tombstone never shares a key with A's, with no intermediate
	// non-tombstoned reload required.
	it('gives a fresh budget to a same-name drop that never left a non-tombstoned row visible', async function () {
		this.timeout(20000);
		const TABLE = `GhostGenerationRace_${process.pid}_${Date.now()}`;
		const Stuck = defineTable(TABLE);
		await Stuck.put({ id: 1, str: 'data' });
		const dbisDb = getDbisDb();

		const tombstone = async (generation) => {
			const meta = dbisDb.getSync(`${TABLE}/`);
			meta.dropping = true;
			meta.dropGeneration = generation;
			await dbisDb.put(`${TABLE}/`, meta);
		};

		const originalRemoveSync = dbisDb.removeSync;
		let attempts = 0;
		dbisDb.removeSync = function (key, ...rest) {
			if (typeof key === 'string' && key.startsWith(`${TABLE}/`)) {
				attempts++;
				throw new Error('Remove failed: Invalid argument: Invalid column family specified in write batch');
			}
			return originalRemoveSync.call(this, key, ...rest);
		};
		const reload = () => {
			resetDatabases();
			getDatabases();
		};

		try {
			// exhaust generation A's budget entirely
			await tombstone('generation-A');
			delete databases[TEST_DB][TABLE];
			for (let i = 0; i < 5; i++) reload();
			const spentOnA = attempts;
			assert.ok(spentOnA > 0, 'generation A must be attempted');

			// jump straight to generation B's tombstone - no reload ever observed a
			// non-tombstoned row in between, unlike the previous test
			await tombstone('generation-B');
			delete databases[TEST_DB][TABLE];
			reload();
			assert.ok(
				attempts > spentOnA,
				`generation B must get its own budget instead of inheriting A's spent count (attempts stuck at ${attempts})`
			);
		} finally {
			dbisDb.removeSync = originalRemoveSync;
		}

		for (const key of [...dbisDb.getKeys({ start: `${TABLE}/`, end: `${TABLE}0` })]) {
			dbisDb.remove(key);
		}
		await dbisDb.committed;
	});

	// Cross-model review: completeInterruptedDrop used to swallow every
	// per-store dropSync failure (not just the tolerated "already dropped"
	// race), then remove the catalog rows and let the caller clear the retry
	// budget anyway - so a store that genuinely failed to drop was declared
	// complete. A same-name recreate would then reuse (LMDB) or resurrect
	// (RocksDB) that store's leftover data. LMDB-only: intercepts
	// rootStore.openDB, the reconcile's own per-store open call, which is not
	// reachable by stubbing a table's primaryStore/dbisDb like the other tests.
	it('a genuine store-drop failure during reconcile preserves the tombstone instead of declaring success', async function () {
		if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') return this.skip();
		this.timeout(20000);
		const TABLE = `GhostDropSyncFail_${process.pid}_${Date.now()}`;
		const Stuck = defineTable(TABLE);
		await Stuck.put({ id: 1, str: 'data' });
		const dbisDb = getDbisDb();
		const rootStore = Stuck.primaryStore.rootStore;
		const meta = dbisDb.getSync(`${TABLE}/`);
		meta.dropping = true;
		await dbisDb.put(`${TABLE}/`, meta);
		delete databases[TEST_DB][TABLE];

		const originalOpenDB = rootStore.openDB;
		rootStore.openDB = function (key, ...rest) {
			const store = originalOpenDB.call(this, key, ...rest);
			if (typeof key === 'string' && key.startsWith(`${TABLE}/`)) {
				store.dropSync = () => {
					throw new Error('disk I/O error');
				};
			}
			return store;
		};
		try {
			resetDatabases();
			getDatabases();
		} finally {
			rootStore.openDB = originalOpenDB;
		}

		const survivingMeta = dbisDb.getSync(`${TABLE}/`);
		assert.ok(survivingMeta?.dropping, 'a genuine store-drop failure must leave the tombstone in place');
		assert.equal(getDatabases()[TEST_DB]?.[TABLE], undefined, 'a tombstoned table must never load');

		// clean up by hand now that dropSync works again
		for (const key of [...dbisDb.getKeys({ start: `${TABLE}/`, end: `${TABLE}0` })]) {
			dbisDb.remove(key);
		}
		await dbisDb.committed;
	});
});
