require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { databases } = require('#src/resources/databases');
const {
	initializeResidencySlots,
	readResidencyMap,
	prepareResidencyDeclaration,
	getResidencyMapTable,
	acquireResidencyMapFence,
	ResidencyPlacementError,
} = require('#src/resources/residencyMaps');
const { transaction } = require('#src/resources/transaction');
const { ClientError } = require('#src/utility/errors/hdbError');
const { hashResidencyKey, createResidencyMap } = require('#src/resources/residencyPolicy');
const { server } = require('#src/server/Server');
const env = require('#src/utility/environment/environmentManager');

describe('Public sharding policy', function () {
	this.timeout(15000);
	let priorShards, priorList, priorShard;
	let sequence = 0;
	before(() => {
		setupTestDBPath();
		priorShards = server.shards;
		priorList = env.get('replication_shards');
		priorShard = env.get('replication_shard');
		env.setProperty('replication_shards', [0, 1]);
		env.setProperty('replication_shard', 0);
		server.shards = new Map([
			[0, [{ name: server.hostname }]],
			[1, [{ name: 'sharded-owner' }]],
		]);
	});
	after(() => {
		server.shards = priorShards;
		env.setProperty('replication_shards', priorList);
		env.setProperty('replication_shard', priorShard);
	});
	async function declare(directive, database = `sharded_policy_${sequence++}`, name = 'Rows') {
		await loadGQLSchema(`type ${name} @table(database: "${database}", replicaExpiration: 0) ${directive} {
			id: ID @primaryKey tenantId: Any @indexed otherTenant: Any @indexed region: String @indexed body: String
		}`);
		return databases[database][name];
	}
	it('creates a 1024-slot database map for the first declaration with no count', async () => {
		const Rows = await declare('@sharded');
		assert.equal(Rows.residency.slots, 1024);
		assert.equal(readResidencyMap(Rows.databaseName).slots, 1024);
		assert.equal(Rows.getResidencySlot('key1'), hashResidencyKey('key1') % 1024);
	});
	it('adopts the installed database count when slots is omitted', async () => {
		const database = `sharded_policy_${sequence++}`;
		await initializeResidencySlots({ database, slots: 24, ranges: [{ start: 0, end: 24, shard: 0 }] });
		const Rows = await declare('@sharded', database);
		assert.equal(Rows.residency.slots, 24);
		assert.equal(Rows.getResidencySlot('key1'), hashResidencyKey('key1') % 24);
	});
	for (const slots of [12, 48])
		it(`refuses a table count ${slots} different from the database count`, async () => {
			const database = `sharded_policy_${sequence++}`;
			await initializeResidencySlots({ database, slots: 24, ranges: [{ start: 0, end: 24, shard: 0 }] });
			await assert.rejects(declare(`@sharded(slots: ${slots})`, database), (error) => {
				assert.match(error.message, /24/);
				assert.match(error.message, new RegExp(String(slots)));
				return true;
			});
			assert.equal(databases[database]?.Rows, undefined);
			assert.equal(readResidencyMap(database).slots, 24);
		});
	it('adopts the winning first-install count after starting with no map', async () => {
		const database = `sharded_policy_${sequence++}`;
		const installing = initializeResidencySlots({ database, slots: 64, ranges: [{ start: 0, end: 64, shard: 0 }] });
		const preparing = prepareResidencyDeclaration(database, 'Rows', {});
		assert.equal(readResidencyMap(database), undefined, 'both operations started before the map committed');
		const [, policy] = await Promise.all([installing, preparing]);
		assert.equal(policy.slots, 64);
		assert.equal((await declare('@sharded', database)).residency.slots, 64);
	});
	it('accepts a declared stored primary key as the by field', async () => {
		const Rows = await declare('@sharded(by: "id")');
		await Rows.put('key1', { id: 'key1', body: 'complete' });
		assert.equal(Rows.primaryStore.getEntry('key1').residencySlot, hashResidencyKey('key1') % 1024);
	});
	for (const field of ['missing', 'derived'])
		it(`refuses a by field that is not stored: ${field}`, async () => {
			await assert.rejects(
				loadGQLSchema(`type Rows @table(database: "sharded_virtual_${field}") @sharded(by: "${field}") {
				id: ID @primaryKey tenantId: String @indexed derived: String @computed(from: "tenantId")
			}`),
				/declared stored attribute/
			);
		});
	it('refuses oversized hashed attributes before commit', async () => {
		const Rows = await declare('@sharded(by: "tenantId")');
		for (const size of [2100, 100000]) {
			await assert.rejects(async () => Rows.put('bad', { id: 'bad', tenantId: 'x'.repeat(size) }), /sharding/);
			assert.equal(Rows.primaryStore.getEntry('bad'), undefined);
		}
	});
	it('classifies source-applied map conflicts and busy fences without changing local validation errors', async () => {
		const database = `sharded_policy_${sequence++}`;
		const before = await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
		const Maps = getResidencyMapTable();
		const fork = createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 1 }], 1);
		await assert.rejects(
			async () => Maps.put(database, fork),
			(error) => error instanceof ClientError && !(error instanceof ResidencyPlacementError)
		);
		const apply = (snapshot) =>
			transaction({ sourceApply: true, timestamp: Date.now() + 100 }, async () => {
				await Maps.put(database, snapshot);
			});
		await assert.rejects(
			async () => apply(fork),
			(error) =>
				error instanceof ResidencyPlacementError && error.cause instanceof ClientError && error.statusCode === 409
		);
		assert.deepEqual(readResidencyMap(database), before);
		const next = createResidencyMap(database, 2, [{ start: 0, end: 2, shard: 1 }], 2);
		const release = acquireResidencyMapFence(database, {});
		try {
			await assert.rejects(
				async () => apply(next),
				(error) =>
					error instanceof ResidencyPlacementError && error.cause.residencyMapBusy === true && error.statusCode === 503
			);
			assert.deepEqual(readResidencyMap(database), before);
		} finally {
			release();
		}
		await apply(next);
		assert.deepEqual(readResidencyMap(database), next);
	});
	it('requires a table for the sharded directive', async () => {
		await assert.rejects(
			loadGQLSchema('type ShardedNonTable @sharded { id: ID @primaryKey }'),
			/only supported on a @table/
		);
	});

	it('refuses unindexed attribute sharding before initializing its map', async () => {
		const database = `sharded_no_index_${sequence++}`;
		await assert.rejects(
			loadGQLSchema(
				`type Rows @table(database: "${database}") @sharded(by: "tenantId") { id: ID @primaryKey tenantId: String }`
			),
			/secondary index/
		);
		assert.equal(readResidencyMap(database), undefined);
	});

	it('rejects the old directive without registering an alias', async () => {
		await assert.rejects(declare('@residency(slots: 1024)'), /Unknown.*@residency/);
	});
	for (const value of ['tenant-a', 'asia', 42, -12.5, 0])
		it(`hashes the attribute value ${JSON.stringify(value)} with the key hash`, async () => {
			const Rows = await declare('@sharded(by: "tenantId")');
			const expected = hashResidencyKey(value) % 1024;
			for (const id of ['first', 'second']) {
				await Rows.put(id, { id, tenantId: value, body: 'complete' });
				assert.equal(Rows.primaryStore.getEntry(id).residencySlot, expected);
			}
		});
	for (const slotFrom of ['', ', slotFrom: "1"'])
		for (const tenantId of [null, undefined])
			it(`refuses ${tenantId} attribute values before commit (${slotFrom || 'hash'})`, async () => {
				const Rows = await declare(`@sharded(by: "tenantId"${slotFrom})`);
				await assert.rejects(async () => Rows.put('bad', { id: 'bad', tenantId }), /tenantId.*null|tenantId.*missing/);
				assert.equal(Rows.primaryStore.getEntry('bad'), undefined);
			});
	it('uses regional expression results as logical slots resolved by the map', async () => {
		const database = `sharded_policy_${sequence++}`;
		await initializeResidencySlots({
			database,
			slots: 3,
			ranges: [
				{ start: 0, end: 2, shard: 0 },
				{ start: 2, end: 3, shard: 1 },
			],
		});
		const Rows = await declare('@sharded(by: "region", slotFrom: "region == \'asia\' ? 1 : 2")', database);
		for (const [region, slot, owner] of [
			['asia', 1, server.hostname],
			['europe', 2, 'sharded-owner'],
		]) {
			await Rows.put(region, { id: region, region, body: region });
			const entry = Rows.primaryStore.getEntry(region);
			assert.equal(entry.residencySlot, slot);
			assert.deepEqual(Rows.getRecordResidency(entry), [owner]);
		}
	});
	for (const expression of ['-1', '3', '1.5', '"2"', 'NaN', 'Infinity', 'undefined'])
		it(`refuses expression result ${expression} with the result and slot count before commit`, async () => {
			const Rows = await declare(`@sharded(slots: 3, by: "region", slotFrom: ${JSON.stringify(expression)})`);
			await assert.rejects(
				async () => Rows.put('bad', { id: 'bad', region: 'asia' }),
				(error) => {
					assert.match(error.message, /3/);
					assert.ok(error.message.includes(expression.replaceAll('"', '')), error.message);
					return true;
				}
			);
			assert.equal(Rows.primaryStore.getEntry('bad'), undefined);
			assert.equal(
				Array.from(Rows.auditStore.getRange({ start: 1 })).filter(
					(entry) => entry.tableId === Rows.tableId && entry.recordId === 'bad'
				).length,
				0
			);
		});
	for (const expression of ['Object.create(null)', 'Symbol("bad")', '(() => { throw undefined; })()'])
		it(`refuses unusual expression results safely: ${expression}`, async () => {
			const Rows = await declare(`@sharded(slots: 3, by: "region", slotFrom: ${JSON.stringify(expression)})`);
			await assert.rejects(
				async () => Rows.put('bad', { id: 'bad', region: 'asia' }),
				(error) => {
					assert.equal(error.statusCode, 400);
					assert.match(error.message, /3.*slots|slots.*3/);
					return true;
				}
			);
			assert.equal(Rows.primaryStore.getEntry('bad'), undefined);
		});
	it('refuses a throwing expression before committing a primary or audit row', async () => {
		const expression = '(() => { throw new Error("region expression failed"); })()';
		const Rows = await declare(`@sharded(slots: 3, by: "region", slotFrom: ${JSON.stringify(expression)})`);
		await assert.rejects(async () => Rows.put('bad', { id: 'bad', region: 'asia' }), /region expression failed/);
		assert.equal(Rows.primaryStore.getEntry('bad'), undefined);
		assert.equal(
			Array.from(Rows.auditStore.getRange({ start: 1 })).filter(
				(entry) => entry.tableId === Rows.tableId && entry.recordId === 'bad'
			).length,
			0
		);
	});
	for (const [before, after] of [
		['by: "tenantId"', 'by: "otherTenant"'],
		['by: "tenantId"', 'by: "tenantId", slotFrom: "0"'],
		['by: "tenantId", slotFrom: "0"', 'by: "tenantId"'],
		['by: "tenantId", slotFrom: "0"', 'by: "tenantId", slotFrom: "1"'],
		['by: "tenantId", slotFrom: "0"', 'by: "otherTenant", slotFrom: "0"'],
	])
		it(`refuses changing populated placement from ${before} to ${after}`, async () => {
			const Rows = await declare(`@sharded(${before})`);
			await Rows.put('row', { id: 'row', tenantId: 'tenant-a', otherTenant: 'tenant-b', body: 'complete' });
			const original = Rows.residency;
			const slot = Rows.primaryStore.getEntry('row').residencySlot;
			await assert.rejects(declare(`@sharded(${after})`, Rows.databaseName), /changed|immutable/);
			assert.deepEqual(Rows.residency, original);
			assert.equal(Rows.primaryStore.getEntry('row').residencySlot, slot);
		});
});
