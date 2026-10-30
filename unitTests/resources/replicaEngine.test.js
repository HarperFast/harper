require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, closeDatabase, resetDatabases } = require('#src/resources/databases');
const { waitFor } = require('../waitFor.js');
const { transaction } = require('#src/resources/transaction');
const { Resource } = require('#src/resources/Resource');
const { INVALIDATED, REPLICA, setMinReplicaScanIntervalForTesting } = require('#src/resources/Table');
const { setMainIsWorker, broadcast } = require('#js/server/threads/manageThreads');
const { server } = require('#src/server/Server');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Replica storage engine support', function () {
	this.timeout(10000);
	let Records;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		setMinReplicaScanIntervalForTesting(20);
		Records = table({
			database: 'test',
			table: 'ReplicaEngine',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
		});
		Records.dbisDB.putSync([Symbol.for('residency_by_id'), 123], ['resident-a']);
	});
	after(() => setMinReplicaScanIntervalForTesting(undefined));

	async function stub(id) {
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource(id, context, { ensureLoaded: false });
			resource._writeInvalidate(id, { name: 'stub' }, { residencyId: 123 });
		});
		return Records.primaryStore.getEntry(id);
	}

	function answer(entry, body = 'complete') {
		return {
			key: entry.key,
			value: { id: entry.key, name: 'stub', body },
			version: entry.version,
			originNode: server.hostname,
			fullWriteHead: entry.version,
		};
	}

	it('keeps one of concurrent admissions that answer one stub, with its index unchanged', async () => {
		const entry = await stub('overlap');
		const history = (await Records.getHistoryOfRecord(entry.key)).map(({ type, version }) => ({ type, version }));
		const results = await Promise.all([
			Records._storeReplica(entry, answer(entry, 'A')),
			Records._storeReplica(entry, answer(entry, 'B')),
		]);
		const current = Records.primaryStore.getEntry(entry.key);
		const ids = [];
		for await (const row of Records.search({ conditions: [{ attribute: 'name', value: 'stub' }], select: ['id'] }))
			ids.push(row.id);
		assert.deepEqual(ids, [entry.key]);
		assert.equal(current.version, entry.version);
		assert.deepEqual(
			(await Records.getHistoryOfRecord(entry.key)).map(({ type, version }) => ({ type, version })),
			history
		);
		if (isLMDB) {
			assert.deepEqual(results, [false, false]);
			assert.deepEqual(current.value, entry.value);
			for (const key of ['metadataFlags', 'residencyId', 'nodeId', 'additionalAuditRefs'])
				assert.deepEqual(current[key], entry[key], `${key} is unchanged`);
			assert.ok(current.metadataFlags & INVALIDATED);
			assert.ok(!(current.metadataFlags & REPLICA));
			assert.equal(Records.dbisDB.getSync(`${Records.tableName}/@replicas`), undefined);
		} else {
			assert.equal(results.filter(Boolean).length, 1, 'exactly one admission wins');
			assert.equal(current.value.body, results[0] ? 'A' : 'B');
			assert.ok(current.metadataFlags & REPLICA);
		}
	});

	it('keeps every LMDB remote read as a proxy read', async function () {
		if (!isLMDB) this.skip();
		const entry = await stub('proxy');
		const admissions = [];
		Records.sourcedFrom(
			class extends Resource {
				static async load(request) {
					const response = answer(request);
					admissions.push(await Records._storeReplica(request, response));
					return response;
				}
			},
			{ intermediateSource: true }
		);
		for (const replicaExpiration of [3600, 0, 0.001]) {
			Records.setTTLExpiration({ replicaExpiration, replicaRefreshFraction: 0.25 });
			assert.equal((await Records.get(entry.key)).body, 'complete');
			assert.equal((await Records.get(entry.key)).body, 'complete');
		}
		assert.deepEqual(admissions, Array(6).fill(false));
		assert.deepEqual(Records.primaryStore.getEntry(entry.key).value, entry.value);
		assert.equal(Records.dbisDB.getSync(`${Records.tableName}/@replicas`), undefined);
	});

	it('arms catalog wakes and maintenance restarts only on RocksDB', async function () {
		const state = new Int32Array(
			Records.primaryStore.getUserSharedBuffer(`replica-sweep:${Records.tableId}`, new ArrayBuffer(8))
		);
		Records.dbisDB.putSync(`${Records.tableName}/@replicas`, { auxiliary: '@replicas', tableId: Records.tableId });
		Records.setTTLExpiration({ replicaExpiration: 0.001 });
		await broadcast(
			{ type: 'replica-eviction-armed', storePath: Records.primaryStore.path, tableId: Records.tableId },
			true
		);
		await waitFor(() => Atomics.load(state, 1) === (isLMDB ? 0 : 1));
		await Records.closeMaintenance();
		Records.setTTLExpiration({ replicaExpiration: 3600 });
		Records.resumeMaintenance();
		await waitFor(() => Atomics.load(state, 1) === (isLMDB ? 0 : 1));
	});

	it('arms a table loaded with replica metadata only on RocksDB', async () => {
		const databaseName = 'replicaEngineReload';
		const Created = table({
			database: databaseName,
			table: 'Reloaded',
			attributes: [{ name: 'id', isPrimaryKey: true }],
			replicaExpiration: 60,
		});
		Created.dbisDB.putSync(`${Created.tableName}/@replicas`, { auxiliary: '@replicas', tableId: Created.tableId });
		await closeDatabase(databaseName);
		const Reloaded = resetDatabases()[databaseName].Reloaded;
		const state = new Int32Array(
			Reloaded.primaryStore.getUserSharedBuffer(`replica-sweep:${Reloaded.tableId}`, new ArrayBuffer(8))
		);
		await waitFor(() => Atomics.load(state, 1) === (isLMDB ? 0 : 1));
		await Reloaded.closeMaintenance();
	});

	it('settles replica sweep ownership acquired after loading the table', async () => {
		const databaseName = 'replicaEngineOwnership';
		const Created = table({
			database: databaseName,
			table: 'Takeover',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
			replicaExpiration: 0.2,
			replicaRefreshFraction: 1,
		});
		Created.dbisDB.putSync([Symbol.for('residency_by_id'), 123], ['resident-a']);
		const context = {};
		await transaction(context, async () => {
			const resource = await Created.getResource('loaded', context, { ensureLoaded: false });
			resource._writeInvalidate('loaded', { name: 'stub' }, { residencyId: 123 });
		});
		const entry = Created.primaryStore.getEntry('loaded');
		assert.equal(await Created._storeReplica(entry, answer(entry)), !isLMDB);
		await closeDatabase(databaseName);
		let Reloaded;
		setMainIsWorker(false);
		try {
			Reloaded = resetDatabases()[databaseName].Takeover;
			const state = new Int32Array(
				Reloaded.primaryStore.getUserSharedBuffer(`replica-sweep:${Reloaded.tableId}`, new ArrayBuffer(8))
			);
			assert.equal(Atomics.load(state, 1), 0);
			setMainIsWorker(true);
			Reloaded.setTTLExpiration({ replicaExpiration: 0.2, replicaRefreshFraction: 1, fromSchema: true });
			assert.equal(Atomics.load(state, 1), isLMDB ? 0 : 1, 'the new owner schedules the already-armed sweep');
			await waitFor(() => Reloaded.primaryStore.getEntry('loaded').metadataFlags & INVALIDATED, {
				timeout: 3000,
				message: 'the new owner demotes the stored replica',
			});
			assert.ok(!(Reloaded.primaryStore.getEntry('loaded').metadataFlags & REPLICA));
		} finally {
			setMainIsWorker(true);
			await Reloaded?.closeMaintenance();
		}
	});

	it('drops a table with replica catalog metadata on either engine', async () => {
		const Dropped = table({
			database: 'test',
			table: 'ReplicaEngineDropped',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const catalog = Dropped.dbisDB;
		const name = Dropped.tableName;
		catalog.putSync(`${name}/@replicas`, { auxiliary: '@replicas', tableId: Dropped.tableId });
		await Dropped.dropTable();
		assert.equal(catalog.getSync(`${name}/@replicas`), undefined);
		assert.equal(catalog.getSync(`${name}/`), undefined);
	});

	it('rejects a replicaRefreshFraction outside (0, 1]', () => {
		for (const value of [0, -1, 1.5, 'half', NaN, true])
			assert.throws(() => Records.setTTLExpiration({ replicaRefreshFraction: value }));
		assert.throws(() =>
			table({
				database: 'test',
				table: 'ResidencyReplicasBadFraction',
				attributes: [{ name: 'id', isPrimaryKey: true }],
				replicaRefreshFraction: 2,
			})
		);
		Records.setTTLExpiration({ replicaRefreshFraction: 1 });
	});

	it('rejects a negative or non-numeric replicaExpiration', () => {
		for (const value of [-1, 'soon', NaN, true, '', Number.MAX_VALUE])
			assert.throws(() => Records.setTTLExpiration({ replicaExpiration: value }));
		assert.throws(() =>
			table({
				database: 'test',
				table: 'ResidencyReplicasBad',
				attributes: [{ name: 'id', isPrimaryKey: true }],
				replicaExpiration: false,
			})
		);
	});
});
