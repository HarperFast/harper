require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table, database, databases, getDatabases, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

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
});
