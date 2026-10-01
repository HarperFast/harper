'use strict';

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const {
	table,
	database,
	databases,
	getDatabases,
	resetDatabases,
	getTableDrops,
	recordTableDrop,
	onTableDropRecorded,
	isDeadGeneration,
} = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const TEST_DB = 'test';

function defineTable(name, createdTime) {
	return table({
		table: name,
		database: TEST_DB,
		createdTime,
		attributes: [
			{ name: 'id', type: 'Int', isPrimaryKey: true },
			{ name: 'str', type: 'String' },
		],
	});
}

function dbisDb() {
	return database({ database: TEST_DB, table: null }).dbisDb;
}

function markerFor(name) {
	return getTableDrops(TEST_DB).find((marker) => marker.table === name);
}

function nextTick() {
	return new Promise((resolve) => setImmediate(resolve));
}

describe('table lifecycle stamps (harper#1212)', () => {
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('stamps createdTime at create, keeps a supplied stamp, and reloads both', async () => {
		const Stamped = defineTable('LifecycleStamped');
		assert.ok(Number.isFinite(Stamped.createdTime), 'a created table carries a finite createdTime');
		assert.ok(Stamped.createdTime <= Date.now() + 1, 'the stamp is on the wall clock');
		const Carried = defineTable('LifecycleCarried', 1234567890);
		assert.equal(Carried.createdTime, 1234567890, 'a peer-propagated definition keeps its origin stamp');

		resetDatabases();
		const reloaded = getDatabases()[TEST_DB];
		assert.equal(reloaded.LifecycleStamped.createdTime, Stamped.createdTime);
		assert.equal(reloaded.LifecycleCarried.createdTime, 1234567890);
		await reloaded.LifecycleStamped.dropTable();
		await reloaded.LifecycleCarried.dropTable();
	});

	it('leaves a durable drop marker that outlives a same-name recreate', async () => {
		const First = defineTable('LifecycleRecreate');
		const firstCreated = First.createdTime;
		await First.put({ id: 1, str: 'old' });
		assert.equal(markerFor('LifecycleRecreate'), undefined, 'no marker before the drop');
		await First.dropTable();

		const marker = markerFor('LifecycleRecreate');
		assert.ok(marker, 'the drop leaves a marker');
		assert.ok(marker.droppedTime >= firstCreated, 'the drop postdates the creation');
		assert.equal(marker.tableId, First.tableId);
		assert.ok(isDeadGeneration(firstCreated, marker.droppedTime), 'the dropped generation reads as dead');
		assert.ok(isDeadGeneration(undefined, marker.droppedTime), 'a generation without a stamp is older than any drop');

		const Second = defineTable('LifecycleRecreate');
		assert.ok(Second.createdTime > marker.droppedTime, 'the recreate is stamped after the drop');
		assert.ok(!isDeadGeneration(Second.createdTime, marker.droppedTime), 'the new generation is alive');
		assert.ok(!isDeadGeneration(marker.droppedTime, marker.droppedTime), 'an equal stamp is not dead');
		assert.deepEqual(markerFor('LifecycleRecreate'), marker, 'the recreate does not disturb the marker');
		assert.equal(await Second.get(1), undefined);

		resetDatabases();
		assert.deepEqual(markerFor('LifecycleRecreate'), marker, 'the marker survives a reload');
		const loaded = getDatabases()[TEST_DB];
		assert.ok(
			Object.keys(loaded).every((name) => !name.startsWith('/')),
			'marker rows never load as tables: ' + Object.keys(loaded)
		);
		await loaded.LifecycleRecreate.dropTable();
	});

	it("records a peer's drop time on a drop that applies it, and only moves a marker forward", async () => {
		const Stale = defineTable('LifecyclePeerTime');
		const peerTime = Stale.createdTime + 5000;
		await Stale.dropTable({ droppedTime: peerTime });
		assert.equal(markerFor('LifecyclePeerTime').droppedTime, peerTime, 'the marker carries the supplied time');

		assert.equal(recordTableDrop(TEST_DB, 'LifecyclePeerTime', peerTime - 1), false, 'an older drop never rolls back');
		assert.equal(markerFor('LifecyclePeerTime').droppedTime, peerTime);
		assert.equal(recordTableDrop(TEST_DB, 'LifecyclePeerTime', Number.NaN), false);
		assert.equal(recordTableDrop(TEST_DB, 'LifecyclePeerTime', peerTime + 1), true);
		assert.equal(markerFor('LifecyclePeerTime').droppedTime, peerTime + 1);
	});

	it("records a peer's drop of a table this node never had, and announces it", async () => {
		const announced = [];
		const listener = onTableDropRecorded((databaseName, tableName) => announced.push(databaseName + '.' + tableName));
		try {
			assert.equal(recordTableDrop(TEST_DB, 'LifecycleNeverHere', 777), true);
			assert.equal(recordTableDrop('no_such_database', 'LifecycleNeverHere', 777), false);
			await nextTick();
		} finally {
			listener.remove();
		}
		assert.deepEqual(announced, [TEST_DB + '.LifecycleNeverHere']);
		assert.deepEqual(markerFor('LifecycleNeverHere'), { table: 'LifecycleNeverHere', droppedTime: 777 });
		assert.equal(databases[TEST_DB].LifecycleNeverHere, undefined, 'recording a marker creates no table');
	});

	it('promotes the tombstone of an interrupted drop to a marker when the load completes it', async () => {
		const Zombie = defineTable('LifecycleZombie');
		await Zombie.put({ id: 1, str: 'alive' });
		const meta = dbisDb().getSync('LifecycleZombie/');
		meta.dropping = true;
		meta.droppedTime = 4242;
		await dbisDb().put('LifecycleZombie/', meta);
		delete databases[TEST_DB].LifecycleZombie;

		resetDatabases();
		assert.equal(getDatabases()[TEST_DB].LifecycleZombie, undefined, 'the tombstoned table must not load');
		assert.equal(dbisDb().getSync('LifecycleZombie/'), undefined, 'the catalog rows are removed');
		assert.equal(markerFor('LifecycleZombie').droppedTime, 4242, 'the tombstone time becomes the marker');
	});
});
