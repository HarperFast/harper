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

(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe)('Sharding policy validation', function () {
	this.timeout(15000);
	let priorShards, priorList, priorShard, priorExperimental, priorMarkers;
	const { Transaction } = require('../rocksdbBindings.mts').rocksdbBindings();
	// Preserve the unsupported attribute cases for #1178 without bypassing native marker admission.
	const attributeIt = typeof Transaction.prototype.usesAbortMarkers === 'function' ? it : it.skip;
	let sequence = 0;
	before(() => {
		setupTestDBPath();
		priorExperimental = env.get('replication_experimentalAttributeSlots');
		priorMarkers = env.get('storage_rocks_transactionLogAbortMarkers');
		env.setProperty('replication_experimentalAttributeSlots', true);
		env.setProperty('storage_rocks_transactionLogAbortMarkers', true);
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
		env.setProperty('replication_experimentalAttributeSlots', priorExperimental);
		env.setProperty('storage_rocks_transactionLogAbortMarkers', priorMarkers);
		env.setProperty('replication_shards', priorList);
		env.setProperty('replication_shard', priorShard);
	});
	async function declare(directive, database = `sharded_policy_${sequence++}`, name = 'Rows') {
		await loadGQLSchema(`type ${name} @table(database: "${database}", replicaExpiration: 0) ${directive} {
			id: ID @primaryKey tenantId: Any @indexed otherTenant: Any @indexed region: String @indexed body: String
		}`);
		return databases[database][name];
	}
	for (const healthyFirst of [false, true])
		it(`keeps database-local live refusal out of schema loading (healthy first=${healthyFirst})`, async () => {
			const { setResidencyPlacementGuard } = require('#src/resources/residencyMaps');
			const { databaseResidencyBlockReason, resetDatabases } = require('#src/resources/databases');
			const database = `sharded_live_${sequence++}`;
			const healthy = database + '_healthy';
			const declarations = [
				`type Held @table(database: "${database}") @sharded { id: ID @primaryKey body: String }`,
				`type Healthy @table(database: "${healthy}") { id: ID @primaryKey body: String }`,
			];
			if (healthyFirst) declarations.reverse();
			declarations.push(`type PlainSibling @table(database: "${database}") { id: ID @primaryKey body: String }`);
			const schema = declarations.join('\n');
			await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
			await loadGQLSchema(schema);
			await databases[healthy].Healthy.put('good', { body: 'healthy' });
			try {
				setResidencyPlacementGuard((name) => {
					if (name === database) throw new ResidencyPlacementError('temporary peer disagreement', 503);
				});
				await loadGQLSchema(schema);
				resetDatabases();
				assert.equal((await databases[healthy].Healthy.get('good')).body, 'healthy');
				await assert.rejects(
					async () => databases[database].Held.put('blocked', { body: 'no' }),
					(error) => error.code === 'DATABASE_SHARDING_HELD' && error.retryable === true
				);
				assert.equal(databases[database].Held.primaryStore.getEntry('blocked'), undefined);
				await assert.rejects(
					async () => databases[database].PlainSibling.put('blocked', { body: 'no' }),
					(error) => error.code === 'DATABASE_SHARDING_HELD'
				);
				assert.equal(databases[database].PlainSibling.primaryStore.getEntry('blocked'), undefined);
				assert.equal(databaseResidencyBlockReason(database), undefined);
			} finally {
				setResidencyPlacementGuard(undefined);
			}
			await databases[database].Held.put('fixed', { body: 'repaired' });
			assert.equal((await databases[database].Held.get('fixed')).body, 'repaired');
		});
	it('refuses a staged transaction at commit when a live hold begins after staging', async () => {
		const { setResidencyPlacementGuard } = require('#src/resources/residencyMaps');
		const database = `sharded_commit_hold_${sequence++}`;
		await initializeResidencySlots({ database, slots: 2, ranges: [{ start: 0, end: 2, shard: 0 }] });
		await declare('@sharded', database);
		await loadGQLSchema(`type Plain @table(database: "${database}") { id: ID @primaryKey body: String }`);
		const Rows = databases[database].Plain;
		let held = false;
		try {
			setResidencyPlacementGuard((name) => {
				if (name === database && held) throw new ResidencyPlacementError('held after staging', 503);
			});
			await assert.rejects(
				transaction({}, async () => {
					await Rows.put('staged', { id: 'staged', body: 'must not commit' });
					held = true;
				}),
				(error) => error.code === 'DATABASE_SHARDING_HELD'
			);
			assert.equal(Rows.primaryStore.getEntry('staged'), undefined);
		} finally {
			setResidencyPlacementGuard(undefined);
		}
		await Rows.put('staged', { id: 'staged', body: 'repair succeeds' });
		assert.equal((await Rows.get('staged')).body, 'repair succeeds');
	});
	it('defers a newly refused declaration and registers it on the next valid reload', async () => {
		const { setResidencyPlacementGuard } = require('#src/resources/residencyMaps');
		const database = `sharded_deferred_${sequence++}`;
		const schema = `type Deferred @table(database: "${database}") @sharded { id: ID @primaryKey }`;
		try {
			setResidencyPlacementGuard((name) => {
				if (name === database) throw new ResidencyPlacementError('temporary disagreement', 503);
			});
			await loadGQLSchema(schema);
			assert.equal(databases[database]?.Deferred, undefined);
		} finally {
			setResidencyPlacementGuard(undefined);
		}
		await loadGQLSchema(schema);
		assert.ok(databases[database].Deferred.residency);
	});
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
	attributeIt('accepts a declared stored primary key as the by field', async () => {
		const Rows = await declare('@sharded(by: "id")');
		await Rows.put('key1', { id: 'key1', body: 'complete' });
		assert.equal(Rows.primaryStore.getEntry('key1').residencySlot, hashResidencyKey('key1') % 1024);
	});
	for (const field of ['missing', 'derived'])
		attributeIt(`refuses a by field that is not stored: ${field}`, async () => {
			await assert.rejects(
				loadGQLSchema(`type Rows @table(database: "sharded_virtual_${field}") @sharded(by: "${field}") {
				id: ID @primaryKey tenantId: String @indexed derived: String @computed(from: "tenantId")
			}`),
				/declared stored attribute/
			);
		});
	for (const type of ['Date', 'Boolean', 'BigInt', 'Bytes', 'Blob', '[String]', 'Payload'])
		attributeIt(`refuses a default by type that cannot be hashed before installing a map: ${type}`, async () => {
			const database = `sharded_type_${sequence++}`;
			await assert.rejects(
				loadGQLSchema(`type Payload { value: String }
				type Rows @table(database: "${database}") @sharded(by: "tenantId") {
					id: ID @primaryKey tenantId: ${type} tag: String @indexed
				}`),
				/@sharded.*(type|string|number)/
			);
			assert.equal(readResidencyMap(database), undefined);
			assert.equal(databases[database]?.Rows, undefined);
		});
	attributeIt('refuses a relationship as the by field even with an explicit expression', async () => {
		const database = `sharded_type_${sequence++}`;
		await assert.rejects(
			loadGQLSchema(`type Tenant @table(database: "${database}") { id: ID @primaryKey }
			type Rows @table(database: "${database}") @sharded(by: "tenant", slotFrom: "0") {
				id: ID @primaryKey tenantId: ID @indexed tenant: Tenant @relationship(from: "tenantId")
			}`),
			/declared stored attribute/
		);
		assert.equal(readResidencyMap(database), undefined);
	});
	attributeIt('allows a stored date when an explicit expression chooses the slot', async () => {
		const database = `sharded_type_${sequence++}`;
		await loadGQLSchema(`type Rows @table(database: "${database}")
			@sharded(by: "createdAt", slotFrom: "createdAt.getUTCMonth()") {
			id: ID @primaryKey createdAt: Date tag: String @indexed
		}`);
		const Rows = databases[database].Rows;
		await Rows.put('row', { id: 'row', createdAt: new Date('2026-01-01T00:00:00Z'), tag: 'date' });
		assert.equal(Rows.primaryStore.getEntry('row').residencySlot, 0);
	});
	attributeIt('keeps negative-zero affinity through native encoding, source apply and patch', async () => {
		const database = `sharded_zero_${sequence++}`;
		await initializeResidencySlots({ database, slots: 1024, ranges: [{ start: 0, end: 1024, shard: 0 }] });
		const Origin = await declare('@sharded(by: "tenantId")', database, 'Origin');
		const Peer = await declare('@sharded(by: "tenantId")', database, 'Peer');
		await Origin.put('row', { id: 'row', tenantId: -0, body: 'complete' });
		const encoded = Origin.primaryStore.getBinary('row');
		const native = Origin.primaryStore.decoder.decode(encoded);
		const decoded = Origin.primaryStore.decoder.isRocksDB ? native.value : native;
		assert.ok(Object.is(decoded.tenantId, 0), 'record encoding canonicalizes negative zero');
		await transaction({ sourceApply: true }, () => Peer.put('row', decoded));
		const slot = Origin.primaryStore.getEntry('row').residencySlot;
		assert.equal(slot, hashResidencyKey(0) % 1024);
		assert.equal(Peer.primaryStore.getEntry('row').residencySlot, slot);
		await Origin.patch('row', { body: 'updated' });
		assert.equal(Origin.primaryStore.getEntry('row').residencySlot, slot);
	});
	attributeIt('refuses oversized hashed attributes before commit', async () => {
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

	attributeIt('refuses unindexed attribute sharding before initializing its map', async () => {
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
		attributeIt(`hashes the attribute value ${JSON.stringify(value)} with the key hash`, async () => {
			const Rows = await declare('@sharded(by: "tenantId")');
			const expected = hashResidencyKey(value) % 1024;
			for (const id of ['first', 'second']) {
				await Rows.put(id, { id, tenantId: value, body: 'complete' });
				assert.equal(Rows.primaryStore.getEntry(id).residencySlot, expected);
			}
		});
	for (const slotFrom of ['', ', slotFrom: "1"'])
		for (const tenantId of [null, undefined])
			attributeIt(`refuses ${tenantId} attribute values before commit (${slotFrom || 'hash'})`, async () => {
				const Rows = await declare(`@sharded(by: "tenantId"${slotFrom})`);
				await assert.rejects(async () => Rows.put('bad', { id: 'bad', tenantId }), /tenantId.*null|tenantId.*missing/);
				assert.equal(Rows.primaryStore.getEntry('bad'), undefined);
			});
	attributeIt('uses regional expression results as logical slots resolved by the map', async () => {
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
		attributeIt(`refuses expression result ${expression} with the result and slot count before commit`, async () => {
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
		attributeIt(`refuses unusual expression results safely: ${expression}`, async () => {
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
	attributeIt('refuses a throwing expression before committing a primary or audit row', async () => {
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
		attributeIt(`refuses changing populated placement from ${before} to ${after}`, async () => {
			const Rows = await declare(`@sharded(${before})`);
			await Rows.put('row', { id: 'row', tenantId: 'tenant-a', otherTenant: 'tenant-b', body: 'complete' });
			const original = Rows.residency;
			const slot = Rows.primaryStore.getEntry('row').residencySlot;
			await assert.rejects(declare(`@sharded(${after})`, Rows.databaseName), /changed|immutable/);
			assert.deepEqual(Rows.residency, original);
			assert.equal(Rows.primaryStore.getEntry('row').residencySlot, slot);
		});
});
