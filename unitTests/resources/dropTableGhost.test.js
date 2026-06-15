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
		const originalDrop = Doomed.primaryStore.drop;
		Doomed.primaryStore.drop = () => Promise.reject(new Error('injected drop failure'));
		try {
			await assert.rejects(() => Doomed.dropTable(), /injected drop failure/);
		} finally {
			Doomed.primaryStore.drop = originalDrop;
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
});
