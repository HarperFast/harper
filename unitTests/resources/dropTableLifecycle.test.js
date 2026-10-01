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
	dropTableMeta,
	onTableDropRecorded,
	isDeadGeneration,
} = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const harperBridge = require('#src/dataLayer/harperBridge/harperBridge').default;

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

	it('stamps a recreate after the newest known drop, even when that drop is ahead of the local clock', async () => {
		const Early = defineTable('LifecycleFutureDrop');
		const future = Date.now() + 60_000;
		await Early.dropTable({ droppedTime: future });
		assert.equal(markerFor('LifecycleFutureDrop').droppedTime, future);
		const Recreated = defineTable('LifecycleFutureDrop');
		assert.ok(Recreated.createdTime > future, 'the recreate must read as newer than the drop it follows');
		assert.ok(!isDeadGeneration(Recreated.createdTime, future));
		await Recreated.dropTable();
		assert.ok(
			markerFor('LifecycleFutureDrop').droppedTime > Recreated.createdTime,
			'the drop follows the creation it retires'
		);
	});

	it('completes a pre-stamp interrupted drop without inventing a drop time for it', async () => {
		const Zombie = defineTable('LifecycleLegacyZombie');
		await Zombie.put({ id: 1, str: 'alive' });
		const meta = dbisDb().getSync('LifecycleLegacyZombie/');
		meta.dropping = true;
		await dbisDb().put('LifecycleLegacyZombie/', meta);
		delete databases[TEST_DB].LifecycleLegacyZombie;

		const Fresh = defineTable('LifecycleLegacyZombie');
		assert.equal(markerFor('LifecycleLegacyZombie'), undefined, "a made-up time could postdate a peer's live recreate");
		assert.equal(await Fresh.get(1), undefined);
		await Fresh.dropTable();
		assert.ok(markerFor('LifecycleLegacyZombie'), 'a stamped drop of the replacement still leaves its marker');
	});

	it('drops a generation stamped by a faster clock with a drop time that still retires it', async () => {
		const ahead = Date.now() + 60_000;
		const Fast = defineTable('LifecycleFastPeerClock', ahead);
		await Fast.dropTable();
		assert.ok(isDeadGeneration(ahead, markerFor('LifecycleFastPeerClock').droppedTime));
	});

	it('keeps the newer of two drop times when a drop joins one already in flight', async () => {
		const Twice = defineTable('LifecycleJoinedDrop');
		await Twice.put({ id: 1, str: 'x' });
		// A real interrupted drop: the tombstone (with its drop generation) is durable, the stores are not gone.
		const original = { drop: Twice.primaryStore.drop, dropSync: Twice.primaryStore.dropSync };
		Twice.primaryStore.dropSync = () => {
			throw new Error('injected drop failure');
		};
		Twice.primaryStore.drop = () => Promise.reject(new Error('injected drop failure'));
		try {
			await assert.rejects(() => Twice.dropTable({ droppedTime: 200 }), /injected drop failure/);
		} finally {
			Object.assign(Twice.primaryStore, original);
		}
		assert.equal(dbisDb().getSync('LifecycleJoinedDrop/')?.droppedTime, 200, 'the tombstone carries the first time');
		assert.equal(markerFor('LifecycleJoinedDrop'), undefined, 'nothing is promoted before the drop completes');

		await Twice.dropTable({ droppedTime: 300 });
		assert.equal(markerFor('LifecycleJoinedDrop').droppedTime, 300, 'the joining drop raises the tombstone time');
	});

	it('announces a recorded marker only once it is readable', async () => {
		let seenInListener;
		const listener = onTableDropRecorded((databaseName, tableName) => {
			if (tableName === 'LifecycleAnnounced') seenInListener = markerFor(tableName)?.droppedTime;
		});
		try {
			const Announced = defineTable('LifecycleAnnounced');
			await Announced.dropTable({ droppedTime: 9999 });
			await nextTick();
		} finally {
			listener.remove();
		}
		assert.equal(seenInListener, 9999, 'the listener must see the marker it was told about');
	});

	it('leaves no marker for a drop the caller asked not to replicate', async () => {
		const Local = defineTable('LifecycleLocalOnly');
		await Local.dropTable({ localOnly: true });
		assert.equal(markerFor('LifecycleLocalOnly'), undefined);
		assert.equal(dbisDb().getSync('LifecycleLocalOnly/'), undefined, 'the drop itself completes');
	});

	it('maps the operation flags onto the drop: local-only, forwarded with the origin time, or plain', async () => {
		defineTable('LifecycleBridgeLocal');
		await harperBridge.dropTable({ schema: TEST_DB, table: 'LifecycleBridgeLocal', replicated: false });
		assert.equal(markerFor('LifecycleBridgeLocal'), undefined, "a client's replicated:false leaves no marker");

		defineTable('LifecycleBridgeForwarded');
		await harperBridge.dropTable({
			schema: TEST_DB,
			table: 'LifecycleBridgeForwarded',
			replicated: false,
			replicatedFrom: 'origin-node',
			droppedTime: 31337,
		});
		assert.equal(
			markerFor('LifecycleBridgeForwarded').droppedTime,
			31337,
			"a peer's forwarded drop keeps the origin's time"
		);

		defineTable('LifecycleBridgeClientTime');
		await harperBridge.dropTable({ schema: TEST_DB, table: 'LifecycleBridgeClientTime', droppedTime: 31337 });
		assert.notEqual(markerFor('LifecycleBridgeClientTime').droppedTime, 31337, "a client's time is not trusted");
	});

	it('a replicating drop that joins a local-only one stamps the bare tombstone', async () => {
		const Bare = defineTable('LifecycleJoinLocalOnly');
		const original = { drop: Bare.primaryStore.drop, dropSync: Bare.primaryStore.dropSync };
		Bare.primaryStore.dropSync = () => {
			throw new Error('injected drop failure');
		};
		Bare.primaryStore.drop = () => Promise.reject(new Error('injected drop failure'));
		try {
			await assert.rejects(() => Bare.dropTable({ localOnly: true }), /injected drop failure/);
		} finally {
			Object.assign(Bare.primaryStore, original);
		}
		assert.equal(
			dbisDb().getSync('LifecycleJoinLocalOnly/')?.droppedTime,
			undefined,
			'the local-only tombstone is bare'
		);
		await Bare.dropTable();
		assert.ok(markerFor('LifecycleJoinLocalOnly'), 'the replicating drop leaves a marker');
	});

	it('promotes a tombstone that dropTableMeta would otherwise erase', async () => {
		const Lingering = defineTable('LifecycleLingeringTombstone');
		const meta = dbisDb().getSync('LifecycleLingeringTombstone/');
		meta.dropping = true;
		meta.droppedTime = 5150;
		await dbisDb().put('LifecycleLingeringTombstone/', meta);
		delete databases[TEST_DB].LifecycleLingeringTombstone;
		await dropTableMeta({ table: 'LifecycleLingeringTombstone', database: TEST_DB });
		assert.equal(dbisDb().getSync('LifecycleLingeringTombstone/'), undefined, 'the rows are removed');
		assert.equal(markerFor('LifecycleLingeringTombstone').droppedTime, 5150, 'the drop time outlives the row');
		void Lingering;
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
