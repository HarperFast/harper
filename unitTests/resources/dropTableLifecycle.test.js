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
	catalogCreatedTime,
	stampTableCreatedTime,
	pendingOrRecordedDropTime,
	onTableDropRecorded,
	isDeadGeneration,
	isDroppedPeerGeneration,
	isNodeLocalTable,
	catalogCreatedBefore,
	tableDropEpoch,
} = require('#src/resources/databases');
const { REPLICATED_FROM } = require('#src/utility/hdbTerms');
const { server } = require('#src/server/Server');
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

function definePeerTable(name) {
	return table({
		table: name,
		database: TEST_DB,
		origin: 'cluster',
		attributes: [
			{ name: 'id', type: 'Int', isPrimaryKey: true },
			{ name: 'str', type: 'String' },
		],
	});
}

function droppedGeneration(error) {
	return error.code === 'TABLE_GENERATION_DROPPED' && error.statusCode === 409;
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
		assert.equal(await Stale.dropTable({ peer: true, droppedTime: peerTime }), true);
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
		await Early.dropTable({ peer: true, droppedTime: future });
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
			await assert.rejects(
				() => Twice.dropTable({ peer: true, droppedTime: Twice.createdTime + 200 }),
				/injected drop failure/
			);
		} finally {
			Object.assign(Twice.primaryStore, original);
		}
		assert.equal(
			dbisDb().getSync('LifecycleJoinedDrop/')?.droppedTime,
			Twice.createdTime + 200,
			'the tombstone carries the first time'
		);
		assert.equal(markerFor('LifecycleJoinedDrop'), undefined, 'nothing is promoted before the drop completes');

		await Twice.dropTable({ peer: true, droppedTime: Twice.createdTime + 300 });
		assert.equal(
			markerFor('LifecycleJoinedDrop').droppedTime,
			Twice.createdTime + 300,
			'the joining drop raises the tombstone time'
		);
	});

	it('announces a recorded marker only once it is readable', async () => {
		let seenInListener;
		const listener = onTableDropRecorded((databaseName, tableName) => {
			if (tableName === 'LifecycleAnnounced') seenInListener = markerFor(tableName)?.droppedTime;
		});
		try {
			const Announced = defineTable('LifecycleAnnounced');
			await Announced.dropTable({ peer: true, droppedTime: Announced.createdTime + 9999 });
			await nextTick();
		} finally {
			listener.remove();
		}
		assert.ok(seenInListener > 9999, 'the listener must see the marker it was told about');
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

		const Forwarded = defineTable('LifecycleBridgeForwarded');
		const originTime = Forwarded.createdTime + 31337;
		await harperBridge.dropTable({
			schema: TEST_DB,
			table: 'LifecycleBridgeForwarded',
			replicated: false,
			droppedTime: originTime,
			[REPLICATED_FROM]: 'origin-node',
		});
		assert.equal(
			markerFor('LifecycleBridgeForwarded').droppedTime,
			originTime,
			"a peer's forwarded drop keeps the origin's time"
		);

		const ClientTime = defineTable('LifecycleBridgeClientTime');
		const claimed = ClientTime.createdTime + 1e12;
		await harperBridge.dropTable({
			schema: TEST_DB,
			table: 'LifecycleBridgeClientTime',
			replicated: false,
			replicatedFrom: 'origin-node',
			droppedTime: claimed,
		});
		assert.equal(databases[TEST_DB].LifecycleBridgeClientTime, undefined, "the client's drop still happens");
		assert.equal(
			markerFor('LifecycleBridgeClientTime'),
			undefined,
			"a body's replicatedFrom is not provenance: the client's replicated:false stands"
		);

		const Spoofed = defineTable('LifecycleBridgeSpoofedTime');
		await harperBridge.dropTable({
			schema: TEST_DB,
			table: 'LifecycleBridgeSpoofedTime',
			replicatedFrom: 'origin-node',
			droppedTime: Spoofed.createdTime - 1,
		});
		assert.equal(
			databases[TEST_DB].LifecycleBridgeSpoofedTime,
			undefined,
			"a client's time cannot make its drop conditional"
		);
		assert.ok(
			markerFor('LifecycleBridgeSpoofedTime').droppedTime > Spoofed.createdTime,
			"nor stands in for this node's"
		);
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

	it('backfills a missing stamp once, from the catalog outward', async () => {
		const Old = defineTable('LifecycleUnstamped');
		const row = dbisDb().getSync('LifecycleUnstamped/');
		delete row.createdTime;
		await dbisDb().put('LifecycleUnstamped/', row);
		assert.equal(catalogCreatedTime(Old), undefined, 'the catalog has no stamp');
		assert.equal(stampTableCreatedTime(Old, 777), true);
		assert.equal(catalogCreatedTime(Old), 777);
		assert.equal(Old.createdTime, 777, 'the loaded class carries it too');
		assert.equal(stampTableCreatedTime(Old, 999), false, 'a present stamp is never rewritten');
		assert.equal(catalogCreatedTime(Old), 777);
		await Old.dropTable();
	});

	it('reports the drop time a forwarded drop should carry, from the marker or a tombstone still completing', async () => {
		assert.equal(pendingOrRecordedDropTime(TEST_DB, 'LifecycleNeverDropped'), undefined);
		const Pending = defineTable('LifecyclePendingDrop');
		const pendingTime = Pending.createdTime + 4040;
		const original = { drop: Pending.primaryStore.drop, dropSync: Pending.primaryStore.dropSync };
		Pending.primaryStore.dropSync = () => {
			throw new Error('injected drop failure');
		};
		Pending.primaryStore.drop = () => Promise.reject(new Error('injected drop failure'));
		try {
			await assert.rejects(() => Pending.dropTable({ peer: true, droppedTime: pendingTime }), /injected drop failure/);
		} finally {
			Object.assign(Pending.primaryStore, original);
		}
		assert.equal(
			pendingOrRecordedDropTime(TEST_DB, 'LifecyclePendingDrop'),
			pendingTime,
			'read from the live tombstone'
		);
		await Pending.dropTable({ peer: true, droppedTime: pendingTime });
		assert.equal(pendingOrRecordedDropTime(TEST_DB, 'LifecyclePendingDrop'), pendingTime, 'read from the marker');
	});

	it('records the drop time of a forwarded drop whose table is already gone here', async () => {
		const { dropTable } = require('#src/dataLayer/schema');
		const result = await dropTable({
			schema: TEST_DB,
			table: 'LifecycleGoneHere',
			replicated: false,
			droppedTime: 5050,
			[REPLICATED_FROM]: 'origin-node',
		});
		assert.match(result.message, /already dropped/);
		assert.equal(markerFor('LifecycleGoneHere').droppedTime, 5050);
		await assert.rejects(
			() => dropTable({ schema: TEST_DB, table: 'LifecycleGoneHere' }),
			/does not exist|not exist|not found/i
		);
	});

	it('removes only catalog rows no generation owns in dropTableMeta', async () => {
		const Live = defineTable('LifecycleMetaLive');
		await dropTableMeta({ table: 'LifecycleMetaLive', database: TEST_DB });
		assert.ok(
			dbisDb().getSync('LifecycleMetaLive/'),
			'a live generation (a recreate, or a kept peer drop) keeps its rows'
		);
		assert.ok(dbisDb().getSync('LifecycleMetaLive/str'));
		await Live.dropTable();

		const Lingering = defineTable('LifecycleLingeringTombstone');
		// settle any schema reload first: a load completes the tombstone itself, which is not what is tested here
		await nextTick();
		getDatabases();
		const meta = dbisDb().getSync('LifecycleLingeringTombstone/');
		meta.dropping = true;
		meta.droppedTime = 5150;
		dbisDb().putSync('LifecycleLingeringTombstone/', meta);
		delete databases[TEST_DB].LifecycleLingeringTombstone;
		dropTableMeta({ table: 'LifecycleLingeringTombstone', database: TEST_DB });
		assert.equal(
			dbisDb().getSync('LifecycleLingeringTombstone/')?.droppedTime,
			5150,
			'a drop still completing keeps the tombstone that resumes it'
		);
		resetDatabases();
		assert.equal(markerFor('LifecycleLingeringTombstone').droppedTime, 5150, 'its completion promotes the time');
		void Lingering;

		await dbisDb().put('LifecycleMetaOrphan/extra', { name: 'extra' });
		await dropTableMeta({ table: 'LifecycleMetaOrphan', database: TEST_DB });
		assert.equal(dbisDb().getSync('LifecycleMetaOrphan/extra'), undefined, 'rows with no primary row are removed');
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

	it("refuses a peer's create of a generation a known drop retired, stamped or not", async () => {
		const First = defineTable('LifecyclePeerCreate');
		await First.dropTable();
		const { droppedTime } = markerFor('LifecyclePeerCreate');
		assert.throws(() => defineTable('LifecyclePeerCreate', droppedTime - 1), droppedGeneration);
		assert.throws(
			() => definePeerTable('LifecyclePeerCreate'),
			droppedGeneration,
			'an unstamped peer create counts as 0'
		);
		assert.equal(databases[TEST_DB].LifecyclePeerCreate, undefined);
		assert.equal(dbisDb().getSync('LifecyclePeerCreate/'), undefined, 'a refused create leaves no catalog row');
		assert.equal(dbisDb().getSync('LifecyclePeerCreate/str'), undefined);

		const Equal = defineTable('LifecyclePeerCreate', droppedTime);
		assert.equal(Equal.createdTime, droppedTime, 'a generation stamped at the drop time survives it');
		await Equal.dropTable();
		const Local = defineTable('LifecyclePeerCreate');
		assert.ok(
			Local.createdTime > markerFor('LifecyclePeerCreate').droppedTime,
			'a local recreate is stamped after the drop'
		);
		await Local.dropTable();
	});

	it('stores an unstamped peer create at 0, which any later drop retires and nothing backfills', async () => {
		const Unstamped = definePeerTable('LifecycleUnstampedPeer');
		assert.equal(Unstamped.createdTime, 0);
		assert.equal(catalogCreatedTime(Unstamped), 0);
		assert.equal(stampTableCreatedTime(Unstamped, Date.now()), false, 'a stamp is never invented for it');
		resetDatabases();
		const Reloaded = getDatabases()[TEST_DB].LifecycleUnstampedPeer;
		assert.equal(Reloaded.createdTime, 0);
		assert.equal(await Reloaded.dropTable({ peer: true, droppedTime: 1 }), true, 'any peer drop retires it');
	});

	it("keeps a generation created after a peer's drop, and still records that drop", async () => {
		const Live = defineTable('LifecyclePeerDropNewer');
		await Live.put({ id: 1, str: 'kept' });
		const olderDrop = Live.createdTime - 1;
		assert.equal(await Live.dropTable({ peer: true, droppedTime: olderDrop }), false);
		assert.equal(databases[TEST_DB].LifecyclePeerDropNewer, Live);
		assert.equal((await Live.get(1)).str, 'kept');
		assert.equal(
			markerFor('LifecyclePeerDropNewer').droppedTime,
			olderDrop,
			'the drop is relayed to peers that need it'
		);
		await Live.put({ id: 2, str: 'still writable' });
		assert.equal((await Live.get(2)).str, 'still writable');
		assert.equal(await Live.dropTable(), true);
	});

	it('re-checks a peer drop under the catalog lock: a stamp written meanwhile keeps the table', async () => {
		const Raced = defineTable('LifecyclePeerDropRaced');
		await Raced.put({ id: 1, str: 'kept' });
		const row = dbisDb().getSync('LifecyclePeerDropRaced/');
		delete row.createdTime;
		await dbisDb().put('LifecyclePeerDropRaced/', row);
		Raced.createdTime = undefined;
		const droppedTime = Date.now();
		const closeMaintenance = Raced.closeMaintenance;
		Raced.closeMaintenance = async function () {
			// another worker proves this pre-stamp table newer than the drop between the pre-check and the lock
			stampTableCreatedTime(Raced, droppedTime + 1);
			return closeMaintenance.apply(this, arguments);
		};
		try {
			assert.equal(await Raced.dropTable({ peer: true, droppedTime }), false);
		} finally {
			Raced.closeMaintenance = closeMaintenance;
		}
		assert.equal(databases[TEST_DB].LifecyclePeerDropRaced, Raced);
		assert.equal(dbisDb().getSync('LifecyclePeerDropRaced/')?.dropping, undefined, 'no tombstone was written');
		await Raced.put({ id: 2, str: 'after' });
		assert.equal((await Raced.get(2)).str, 'after', 'maintenance resumed');
		assert.equal(markerFor('LifecyclePeerDropRaced').droppedTime, droppedTime);
		await Raced.dropTable();
	});

	it('never lets a peer drop retire a replicate:false table, whose own drop leaves no marker', async () => {
		const defineLocal = (name) =>
			table({
				table: name,
				database: TEST_DB,
				replicate: false,
				attributes: [{ name: 'id', type: 'Int', isPrimaryKey: true }],
			});
		const Local = defineLocal('LifecycleNodeLocal');
		await Local.put({ id: 1 });
		const peerTime = Local.createdTime + 1000;
		assert.equal(await Local.dropTable({ peer: true, droppedTime: peerTime }), false);
		assert.equal(await Local.dropTable({ peer: true }), false, "an older peer's untimed drop too");
		assert.equal(databases[TEST_DB].LifecycleNodeLocal, Local);
		assert.deepEqual(await Local.get(1), { id: 1 });
		assert.equal(markerFor('LifecycleNodeLocal').droppedTime, peerTime, "the peer's drop is still relayed");

		const Dropped = defineLocal('LifecycleNodeLocalDrop');
		assert.equal(await Dropped.dropTable(), true);
		assert.equal(markerFor('LifecycleNodeLocalDrop'), undefined, 'peers never learn of a node-local drop');

		const replicated = [];
		const replicateOperation = server.replication.replicateOperation;
		server.replication.replicateOperation = (request) => {
			replicated.push({ ...request });
			return Promise.resolve({ message: '' });
		};
		try {
			defineLocal('LifecycleNodeLocalOperation');
			const { dropTable } = require('#src/dataLayer/schema');
			await dropTable({ schema: TEST_DB, table: 'LifecycleNodeLocalOperation' });
		} finally {
			server.replication.replicateOperation = replicateOperation;
		}
		assert.equal(replicated.length, 1);
		assert.equal(replicated[0].replicated, false, "a node-local table's drop is not forwarded to peers");
	});

	it("answers a peer's forwarded drop that keeps a newer generation without touching its catalog", async () => {
		const Live = defineTable('LifecycleForwardedKept');
		await Live.put({ id: 1, str: 'kept' });
		const { dropTable } = require('#src/dataLayer/schema');
		const result = await dropTable({
			schema: TEST_DB,
			table: 'LifecycleForwardedKept',
			replicated: false,
			droppedTime: Live.createdTime - 1,
			[REPLICATED_FROM]: 'origin-node',
		});
		assert.match(result.message, /not dropped/);
		assert.ok(dbisDb().getSync('LifecycleForwardedKept/'), "the newer generation's catalog is intact");
		assert.ok(dbisDb().getSync('LifecycleForwardedKept/str'));
		assert.equal((await Live.get(1)).str, 'kept');
		await Live.dropTable();
	});

	it("judges a peer's generation against the drops known here", async () => {
		assert.equal(isDroppedPeerGeneration(TEST_DB, 'LifecycleJudgedNever', 1), false, 'no drop, nothing is dead');
		const First = defineTable('LifecycleJudged');
		await First.dropTable();
		const { droppedTime } = markerFor('LifecycleJudged');
		assert.equal(isDroppedPeerGeneration(TEST_DB, 'LifecycleJudged', droppedTime - 1), true);
		assert.equal(isDroppedPeerGeneration(TEST_DB, 'LifecycleJudged', droppedTime), false);
		assert.equal(isDroppedPeerGeneration(TEST_DB, 'LifecycleJudged', 0), true);
		assert.equal(isDroppedPeerGeneration(TEST_DB, 'LifecycleJudged', undefined), true, 'unstamped, with no live table');
		const Recreated = defineTable('LifecycleJudged');
		assert.equal(
			isDroppedPeerGeneration(TEST_DB, 'LifecycleJudged', undefined),
			false,
			'an unstamped peer is taken to describe the newer live generation'
		);
		assert.equal(
			isDroppedPeerGeneration(TEST_DB, 'LifecycleJudged', droppedTime - 1),
			true,
			'a stamped stale one is not'
		);
		await Recreated.dropTable();
	});

	it('refuses a stale stamped peer definition of a live, newer generation without merging its attributes', async () => {
		const First = defineTable('LifecycleStaleMerge');
		const staleCreated = First.createdTime;
		await First.dropTable();
		const Live = defineTable('LifecycleStaleMerge');
		assert.throws(
			() =>
				table({
					table: 'LifecycleStaleMerge',
					database: TEST_DB,
					origin: 'cluster',
					createdTime: staleCreated,
					attributes: [
						{ name: 'id', type: 'Int', isPrimaryKey: true },
						{ name: 'str', type: 'String' },
						{ name: 'retiredOnly', type: 'String' },
					],
				}),
			droppedGeneration
		);
		assert.equal(databases[TEST_DB].LifecycleStaleMerge, Live);
		assert.equal(dbisDb().getSync('LifecycleStaleMerge/retiredOnly'), undefined, "the retired generation's attribute");
		assert.ok(!Live.attributes.some((attribute) => attribute.name === 'retiredOnly'));
		await Live.dropTable();
	});

	it("reads a table's replicate flag from its catalog row, and from the class only where the row has none", async () => {
		const Redeclared = defineTable('LifecycleReplicateFlag');
		const row = dbisDb().getSync('LifecycleReplicateFlag/');
		Redeclared.replicate = false;
		dbisDb().putSync('LifecycleReplicateFlag/', { ...row, replicate: true });
		assert.equal(isNodeLocalTable(Redeclared), false, 'a stale class flag loses to the declaration on disk');
		dbisDb().putSync('LifecycleReplicateFlag/', { ...row, replicate: false });
		Redeclared.replicate = undefined;
		assert.equal(isNodeLocalTable(Redeclared), true);
		dbisDb().putSync('LifecycleReplicateFlag/', row);
		Redeclared.replicate = false;
		assert.equal(isNodeLocalTable(Redeclared), true, 'a runtime exclusion is the class flag alone');
		Redeclared.replicate = undefined;
		await Redeclared.dropTable();
	});

	it("takes a forwarded drop as a peer's from the operation context, never from the body", async () => {
		const { operation } = require('#src/server/serverHelpers/serverUtilities');
		const Live = defineTable('LifecycleOperationContext');
		const olderDrop = Live.createdTime - 1;
		const forwarded = (table) => ({
			operation: 'drop_table',
			schema: TEST_DB,
			table,
			replicated: false,
			droppedTime: olderDrop,
		});
		await operation(forwarded('LifecycleOperationContext'), { replicatedFrom: 'origin-node' }, false);
		assert.equal(databases[TEST_DB].LifecycleOperationContext, Live, "the peer's drop predates this generation");
		assert.equal(markerFor('LifecycleOperationContext').droppedTime, olderDrop);

		await operation(forwarded('LifecycleOperationContextGone'), { replicatedFrom: 'origin-node' }, false);
		assert.equal(
			markerFor('LifecycleOperationContextGone').droppedTime,
			olderDrop,
			"a peer's drop of a table gone here"
		);
		await assert.rejects(
			() => operation({ ...forwarded('LifecycleOperationContextClaimed'), replicatedFrom: 'origin-node' }, {}, false),
			/does not exist|not exist|not found/i,
			"a body's claim is a client's drop"
		);
		assert.equal(markerFor('LifecycleOperationContextClaimed'), undefined);
	});

	it('bounds the creation of a table a build before the stamps created, once, at the next load', () => {
		const Old = defineTable('LifecycleCreatedBefore');
		const Stamped = defineTable('LifecycleCreatedBeforeStamped');
		const row = dbisDb().getSync('LifecycleCreatedBefore/');
		delete row.createdTime;
		dbisDb().putSync('LifecycleCreatedBefore/', row);
		const loadedAfter = Date.now();
		resetDatabases();
		const bound = catalogCreatedBefore(getDatabases()[TEST_DB].LifecycleCreatedBefore);
		assert.ok(bound >= loadedAfter, 'the load that first sees it bounds it');
		resetDatabases();
		assert.equal(catalogCreatedBefore(getDatabases()[TEST_DB].LifecycleCreatedBefore), bound, 'later loads keep it');
		assert.equal(catalogCreatedBefore(getDatabases()[TEST_DB].LifecycleCreatedBeforeStamped), undefined);
		void Old;
		void Stamped;
	});

	it('advances the drop epoch whenever a marker is recorded, and only then', async () => {
		const before = tableDropEpoch();
		assert.equal(recordTableDrop(TEST_DB, 'LifecycleEpoch', 4242), true);
		await nextTick();
		assert.equal(tableDropEpoch(), before + 1);
		assert.equal(recordTableDrop(TEST_DB, 'LifecycleEpoch', 4242), false, 'a marker that is not newer is not news');
		await nextTick();
		assert.equal(tableDropEpoch(), before + 1);
	});

	it('keeps a runtime-excluded system table node-local whatever its catalog row says', () => {
		const { NON_REPLICATING_SYSTEM_TABLES, replicateIsFalse } = require('#src/resources/databases');
		const excluded = { databaseName: 'system', tableName: NON_REPLICATING_SYSTEM_TABLES[0], replicate: false };
		assert.equal(replicateIsFalse({ replicate: true }, excluded), true);
		assert.equal(
			replicateIsFalse({ replicate: true }, { databaseName: TEST_DB, tableName: 'x', replicate: false }),
			false
		);
	});

	it("judges a peer's generation against a drop still completing here", async () => {
		const Pending = defineTable('LifecycleJudgedPending');
		const dropTime = Pending.createdTime + 1000;
		const original = { drop: Pending.primaryStore.drop, dropSync: Pending.primaryStore.dropSync };
		Pending.primaryStore.dropSync = () => {
			throw new Error('injected drop failure');
		};
		Pending.primaryStore.drop = () => Promise.reject(new Error('injected drop failure'));
		try {
			await assert.rejects(() => Pending.dropTable({ peer: true, droppedTime: dropTime }), /injected drop failure/);
		} finally {
			Object.assign(Pending.primaryStore, original);
		}
		assert.equal(markerFor('LifecycleJudgedPending'), undefined, 'no marker until the drop completes');
		assert.equal(isDroppedPeerGeneration(TEST_DB, 'LifecycleJudgedPending', dropTime - 1), true);
		assert.equal(isDroppedPeerGeneration(TEST_DB, 'LifecycleJudgedPending', dropTime), false);
	});

	it('leaves the tombstone of a drop that failed after writing it for the next load to complete', async () => {
		const Failed = defineTable('LifecycleCleanupFailed');
		await Failed.put({ id: 1, str: 'x' });
		const cleanup = Failed.cleanup;
		Failed.cleanup = () => {
			throw new Error('injected cleanup failure');
		};
		try {
			await assert.rejects(() => Failed.dropTable(), /injected cleanup failure/);
		} finally {
			Failed.cleanup = cleanup;
			Failed.cleanup();
		}
		resetDatabases();
		await nextTick();
		assert.equal(getDatabases()[TEST_DB].LifecycleCleanupFailed, undefined);
		assert.equal(dbisDb().getSync('LifecycleCleanupFailed/'), undefined, 'the load completed the interrupted drop');
		assert.ok(markerFor('LifecycleCleanupFailed'), 'and promoted its tombstone to a marker');
	});
});
