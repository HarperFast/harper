require('../testUtils');
const assert = require('node:assert');
const { Worker } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { loadGQLSchema } = require('#src/resources/graphql');
const { databases, resetDatabases, table } = require('#src/resources/databases');
const { defineTable, types } = require('#src/resources/defineTable');
const { getPlaneBinding } = require('#src/resources/indexes/hnswPlaneBinding');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const DATABASE = 'declared_catalog';

// what a peer's table definition reaches table() as: name, type and isPrimaryKey per attribute, every attribute
// indexed when the peer's table has no schema
function createFromPeer(tableName, attributes, schemaDefined = true) {
	return table({
		table: tableName,
		database: DATABASE,
		schemaDefined,
		attributes: attributes.map(([name, type, isPrimaryKey]) =>
			schemaDefined || isPrimaryKey ? { name, type, isPrimaryKey } : { name, type, indexed: true }
		),
		origin: 'cluster',
	});
}

async function committed(tableName) {
	const Table = databases[DATABASE][tableName];
	await Table.indexingOperation;
	if (Table.dbisDB.committed) await Table.dbisDB.committed;
}

function catalogRow(tableName, attributeName = '') {
	return databases[DATABASE][tableName].dbisDB.getSync(`${tableName}/${attributeName}`);
}

function liveAttribute(tableName, attributeName) {
	return databases[DATABASE][tableName].attributes.find((attribute) => attribute.name === attributeName);
}

async function searchIds(Table, attribute, value) {
	const ids = [];
	for await (const record of Table.search({ conditions: [{ attribute, value }] })) ids.push(record.id);
	return ids.sort();
}

function startCatalogReader() {
	const worker = new Worker(__dirname + '/declaredSchemaCatalog-thread.js', { workerData: { database: DATABASE } });
	const failure = new Promise((_, reject) => worker.once('error', reject));
	return {
		report: () =>
			Promise.race([
				failure,
				new Promise((resolve, reject) => {
					worker.once('message', ({ result, error }) => (error ? reject(new Error(error)) : resolve(result)));
					worker.postMessage('report');
				}),
			]),
		stop: () => worker.terminate(),
	};
}

const PEER_SCHEMA = `
type PeerStamped @table(database: "${DATABASE}") {
	id: ID! @primaryKey
	name: String
	createdAt: String @createdTime
	updatedAt: String @updatedTime
	validUntil: Float @expiresAt
}
type RelOrg @table(database: "${DATABASE}") {
	id: ID @primaryKey
	name: String
	members: [RelMember] @relationship(to: orgId)
}
type RelMember @table(database: "${DATABASE}") {
	id: ID @primaryKey
	orgId: ID @indexed
	org: RelOrg @relationship(from: orgId)
}`;

describe('A local schema declaration persists what it declares into the attribute catalog', function () {
	this.timeout(30000);
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	describe('a table first created from a peer, then declared', function () {
		const readers = [];
		let warmReader;
		before(async function () {
			createFromPeer('PeerStamped', [
				['id', 'ID', true],
				['name', 'String'],
				['createdAt', 'String'],
				['updatedAt', 'String'],
				['validUntil', 'Float'],
			]);
			createFromPeer('RelOrg', [
				['id', 'ID', true],
				['name', 'String'],
				['members', 'array'],
			]);
			createFromPeer(
				'RelMember',
				[
					['id', 'ID', true],
					['orgId', 'ID'],
					['org', 'RelOrg'],
				],
				false
			);
			await databases[DATABASE].RelOrg.put('o1', { id: 'o1', name: 'org one' });
			await databases[DATABASE].RelMember.put('m1', { id: 'm1', orgId: 'o1' });
			for (const tableName of ['PeerStamped', 'RelOrg', 'RelMember']) await committed(tableName);
			warmReader = startCatalogReader();
			readers.push(warmReader);
			const before = await warmReader.report();
			assert.strictEqual(before.orgIndexRegistered, true, 'the other thread loaded the peer row and its index');

			await loadGQLSchema(PEER_SCHEMA);
			for (const tableName of ['PeerStamped', 'RelOrg', 'RelMember']) await committed(tableName);
		});
		after(async function () {
			for (const reader of readers) await reader.stop();
		});

		it('persists the timestamp flags and the required primary key', function () {
			assert.strictEqual(catalogRow('PeerStamped', 'createdAt').assignCreatedTime, true);
			assert.strictEqual(catalogRow('PeerStamped', 'updatedAt').assignUpdatedTime, true);
			assert.strictEqual(catalogRow('PeerStamped', 'validUntil').expiresAt, true);
			assert.strictEqual(catalogRow('PeerStamped').nullable, false);
		});

		it('removes the rows named like declared relationships and unregisters their index', function () {
			assert.strictEqual(catalogRow('RelOrg', 'members'), undefined);
			assert.strictEqual(catalogRow('RelMember', 'org'), undefined);
			assert.strictEqual(databases[DATABASE].RelMember.indices.org, undefined);
		});

		it('stops maintaining that index at once, while a build the same declaration started still runs', async function () {
			createFromPeer(
				'SoloNode',
				[
					['id', 'ID', true],
					['parentId', 'ID'],
					['parent', 'SoloNode'],
				],
				false
			);
			await databases[DATABASE].SoloNode.put('root', { id: 'root' });
			await databases[DATABASE].SoloNode.put('leaf', { id: 'leaf', parentId: 'root' });
			await committed('SoloNode');
			// one table() call, so no later call's signal reloads the table before the rebuild finishes
			table({
				table: 'SoloNode',
				database: DATABASE,
				schemaDefined: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'parentId', type: 'ID', indexed: {} },
					{
						name: 'parent',
						type: 'SoloNode',
						relationship: { from: 'parentId' },
						definition: { tableClass: databases[DATABASE].SoloNode },
					},
				],
			});
			assert.ok(catalogRow('SoloNode', 'parentId').indexingBuildId, 'the rebuild of parentId is still running');
			assert.strictEqual(catalogRow('SoloNode', 'parent'), undefined);
			assert.strictEqual(databases[DATABASE].SoloNode.indices.parent, undefined);
			await committed('SoloNode');
			const leaf = await databases[DATABASE].SoloNode.get({ id: 'leaf', select: ['id', 'parent'] });
			assert.strictEqual(leaf.parent?.id, 'root');
		});

		it('stamps the declared times after a reload', async function () {
			resetDatabases();
			const { PeerStamped } = databases[DATABASE];
			assert.strictEqual(liveAttribute('PeerStamped', 'id').nullable, false);
			const validUntil = Date.now() + 3_600_000;
			await PeerStamped.put('a', { id: 'a', name: 'first', validUntil });
			const record = await PeerStamped.get('a');
			assert.ok(record.createdAt, 'createdAt is stamped');
			assert.ok(record.updatedAt, 'updatedAt is stamped');
			assert.strictEqual(PeerStamped.primaryStore.getEntry('a')?.expiresAt, validUntil);
		});

		it('resolves both relationship directions after a reload', async function () {
			resetDatabases();
			const member = await databases[DATABASE].RelMember.get({ id: 'm1', select: ['id', 'org'] });
			assert.strictEqual(member.org?.id, 'o1');
			const org = await databases[DATABASE].RelOrg.get({ id: 'o1', select: ['id', 'members'] });
			assert.deepStrictEqual(
				org.members?.map((related) => related.id),
				['m1']
			);
		});

		it('reaches a thread that loaded the catalog before the declaration', async function () {
			assert.deepStrictEqual(await warmReader.report(), {
				primaryKeyNullable: false,
				createdTime: true,
				updatedTime: true,
				orgIndexRegistered: false,
				memberOrg: 'o1',
				orgMembers: ['m1'],
			});
		});

		it('reaches a thread that has only ever read the catalog', async function () {
			const coldReader = startCatalogReader();
			readers.push(coldReader);
			assert.deepStrictEqual(await coldReader.report(), {
				primaryKeyNullable: false,
				createdTime: true,
				updatedTime: true,
				orgIndexRegistered: false,
				memberOrg: 'o1',
				orgMembers: ['m1'],
			});
		});

		it('keeps the relationship rows away when the peer sends its definition again', async function () {
			createFromPeer(
				'RelMember',
				[
					['id', 'ID', true],
					['orgId', 'ID'],
					['org', 'RelOrg'],
				],
				false
			);
			await committed('RelMember');
			assert.strictEqual(catalogRow('RelMember', 'org'), undefined);
			resetDatabases();
			const member = await databases[DATABASE].RelMember.get({ id: 'm1', select: ['id', 'org'] });
			assert.strictEqual(member.org?.id, 'o1');
		});
	});

	describe('a declaration that changes an existing table', function () {
		it('keeps a directive added to or removed from an attribute across a reload', async function () {
			const declare = (directives) =>
				loadGQLSchema(`
				type Stamped @table(database: "${DATABASE}") {
					id: ID @primaryKey
					${directives.description ?? ''}
					seenAt: String ${directives.seenAt ?? ''}
					changedAt: String ${directives.changedAt ?? ''}
					validUntil: Float ${directives.validUntil ?? ''}
					label: String ${directives.label ?? ''}
				}`);
			await declare({});
			await declare({
				description: '"when it was seen"',
				seenAt: '@createdTime',
				changedAt: '@updatedTime',
				validUntil: '@expiresAt',
				label: '@hidden @allow(role: "admin")',
			});
			await committed('Stamped');
			resetDatabases();
			assert.strictEqual(liveAttribute('Stamped', 'seenAt').assignCreatedTime, true);
			assert.strictEqual(liveAttribute('Stamped', 'seenAt').description, 'when it was seen');
			assert.strictEqual(liveAttribute('Stamped', 'changedAt').assignUpdatedTime, true);
			assert.strictEqual(liveAttribute('Stamped', 'validUntil').expiresAt, true);
			assert.strictEqual(liveAttribute('Stamped', 'label').hidden, true);
			assert.deepStrictEqual(liveAttribute('Stamped', 'label').authorizedRoles, ['admin']);
			await databases[DATABASE].Stamped.put('s1', { id: 's1', label: 'one' });
			const record = await databases[DATABASE].Stamped.get('s1');
			assert.ok(record.seenAt && record.changedAt, 'both times are stamped');

			await declare({ label: '@allow(role: "auditor")' });
			await committed('Stamped');
			resetDatabases();
			assert.deepStrictEqual(liveAttribute('Stamped', 'label').authorizedRoles, ['auditor']);
			for (const [name, field] of [
				['seenAt', 'assignCreatedTime'],
				['seenAt', 'description'],
				['changedAt', 'assignUpdatedTime'],
				['validUntil', 'expiresAt'],
				['label', 'hidden'],
			])
				assert.strictEqual(liveAttribute('Stamped', name)[field], undefined, `${name}.${field} is gone`);
		});

		it("keeps the primary key's declared fields beside the table settings", async function () {
			const declare = (primaryKey) =>
				loadGQLSchema(`
				type KeyFields @table(database: "${DATABASE}", expiration: 3600) @sealed {
					${primaryKey}
					name: String
				}`);
			await declare('id: ID @primaryKey');
			await declare('"the key" id: ID! @primaryKey @hidden');
			await committed('KeyFields');
			const row = catalogRow('KeyFields');
			assert.strictEqual(row.nullable, false);
			assert.strictEqual(row.hidden, true);
			assert.strictEqual(row.description, 'the key');
			assert.strictEqual(row.sealed, true);
			assert.strictEqual(row.expiration, 3600);
			assert.strictEqual(row.isPrimaryKey, true);

			await declare('id: ID @primaryKey');
			await committed('KeyFields');
			const cleared = catalogRow('KeyFields');
			assert.strictEqual(cleared.nullable, undefined);
			assert.strictEqual(cleared.hidden, undefined);
			assert.strictEqual(cleared.description, undefined);
			assert.strictEqual(cleared.sealed, true);
			assert.strictEqual(cleared.expiration, 3600);
		});

		it("leaves a keyless table's settings row to its settings", async function () {
			const schema = `
			type Keyless @table(database: "${DATABASE}", expiration: 600) {
				name: String @hidden
			}`;
			await loadGQLSchema(schema);
			await loadGQLSchema(schema);
			await committed('Keyless');
			const row = catalogRow('Keyless');
			assert.strictEqual(row.expiration, 600);
			assert.strictEqual(row.hidden, undefined);
			assert.strictEqual(catalogRow('Keyless', 'name').hidden, true);
		});

		it('persists an enum declared through defineTable, and writes nothing when it is unchanged', async function () {
			const declare = (values) =>
				defineTable('Enumerated', { id: types.id.primaryKey, status: types.enum(values) }, { database: DATABASE });
			declare(['open']);
			declare(['open', 'closed']);
			await committed('Enumerated');
			assert.deepStrictEqual(catalogRow('Enumerated', 'status').enum, ['open', 'closed']);
			resetDatabases();
			assert.deepStrictEqual(liveAttribute('Enumerated', 'status').enum, ['open', 'closed']);
			const schemaVersion = databases[DATABASE].Enumerated.schemaVersion;
			declare(['open', 'closed']);
			assert.strictEqual(databases[DATABASE].Enumerated.schemaVersion, schemaVersion);
		});

		it('writes nothing when an unchanged schema is declared again', async function () {
			const schema = `
			"a documented table"
			type Unchanged @table(database: "${DATABASE}") {
				"the key"
				id: ID! @primaryKey @hidden
				createdAt: String @createdTime
				updatedAt: Float @updatedTime @indexed
				validUntil: Float @expiresAt
				secret: String @hidden @allow(role: "admin")
			}`;
			await loadGQLSchema(schema);
			await committed('Unchanged');
			// a restart: the catalog loads, then the schema is declared over it
			resetDatabases();
			const schemaVersion = databases[DATABASE].Unchanged.schemaVersion;
			await loadGQLSchema(schema);
			await loadGQLSchema(schema);
			assert.strictEqual(databases[DATABASE].Unchanged.schemaVersion, schemaVersion);
		});
	});

	describe('indexes under a declaration that changes only metadata', function () {
		it('keeps indexing nulls', async function () {
			const declare = (description) =>
				loadGQLSchema(`
				type NullIndexed @table(database: "${DATABASE}") {
					id: ID @primaryKey
					${description}
					tag: String @indexed
				}`);
			await declare('');
			await databases[DATABASE].NullIndexed.put('n1', { id: 'n1', tag: null });
			await committed('NullIndexed');
			assert.strictEqual(catalogRow('NullIndexed', 'tag').indexNulls, true);

			await declare('"the tag"');
			await committed('NullIndexed');
			assert.strictEqual(catalogRow('NullIndexed', 'tag').description, 'the tag');
			assert.strictEqual(catalogRow('NullIndexed', 'tag').indexNulls, true);
			resetDatabases();
			const { NullIndexed } = databases[DATABASE];
			assert.strictEqual(NullIndexed.indices.tag.indexNulls, true);
			await NullIndexed.put('n1', { id: 'n1', tag: 'x' });
			await NullIndexed.put('n2', { id: 'n2', tag: null });
			assert.deepStrictEqual(await searchIds(NullIndexed, 'tag', null), ['n2']);
			assert.deepStrictEqual(await searchIds(NullIndexed, 'tag', 'x'), ['n1']);
		});

		it('keeps excluding nulls from an index built without them', async function () {
			const declare = (fields) =>
				table({
					table: 'NullsExcluded',
					database: DATABASE,
					schemaDefined: true,
					attributes: [
						{ name: 'id', type: 'ID', isPrimaryKey: true },
						{ name: 'tag', type: 'String', indexed: true, ...fields },
					],
				});
			declare({ indexNulls: false });
			declare({ description: 'the tag' });
			await committed('NullsExcluded');
			assert.strictEqual(catalogRow('NullsExcluded', 'tag').description, 'the tag');
			assert.strictEqual(catalogRow('NullsExcluded', 'tag').indexNulls, false);
		});

		it('keeps a declaration made while the index builds', async function () {
			const declare = (fields) =>
				table({
					table: 'Building',
					database: DATABASE,
					schemaDefined: true,
					attributes: [
						{ name: 'id', type: 'ID', isPrimaryKey: true },
						{ name: 'tag', type: 'String', ...fields },
					],
				});
			declare({});
			for (let i = 0; i < 200; i++) await databases[DATABASE].Building.put(`b${i}`, { id: `b${i}`, tag: `t${i % 7}` });
			await committed('Building');
			// the build yields before its first record, so both declarations land while it runs
			declare({ indexed: true });
			const buildId = catalogRow('Building', 'tag').indexingBuildId;
			declare({ indexed: true, description: 'the tag', assignUpdatedTime: true });
			assert.strictEqual(
				catalogRow('Building', 'tag').indexingBuildId,
				buildId,
				'the metadata change started no build'
			);
			await committed('Building');
			const row = catalogRow('Building', 'tag');
			assert.strictEqual(row.indexingBuildId, undefined, 'the build completed');
			assert.strictEqual(row.description, 'the tag');
			assert.strictEqual(row.assignUpdatedTime, true);
			resetDatabases();
			assert.strictEqual(liveAttribute('Building', 'tag').description, 'the tag');
			const tagged = Array.from({ length: 200 }, (_, i) => i)
				.filter((i) => i % 7 === 3)
				.map((i) => `b${i}`)
				.sort();
			assert.deepStrictEqual(await searchIds(databases[DATABASE].Building, 'tag', 't3'), tagged);
		});

		it('keeps an index dropped from the declaration while it builds dropped', async function () {
			const declare = (fields) =>
				table({
					table: 'DroppedWhileBuilding',
					database: DATABASE,
					schemaDefined: true,
					attributes: [
						{ name: 'id', type: 'ID', isPrimaryKey: true },
						{ name: 'tag', type: 'String', ...fields },
					],
				});
			declare({});
			const { DroppedWhileBuilding } = databases[DATABASE];
			for (let i = 0; i < 200; i++) await DroppedWhileBuilding.put(`b${i}`, { id: `b${i}`, tag: `t${i % 7}` });
			await committed('DroppedWhileBuilding');
			declare({ indexed: true });
			const build = DroppedWhileBuilding.indexingOperation;
			assert.ok(catalogRow('DroppedWhileBuilding', 'tag').indexingBuildId, 'a build is running');
			declare({});
			await build;
			await committed('DroppedWhileBuilding');
			assert.strictEqual(catalogRow('DroppedWhileBuilding', 'tag').indexed, undefined);
			assert.strictEqual(catalogRow('DroppedWhileBuilding', 'tag').indexingBuildId, undefined);
			resetDatabases();
			assert.strictEqual(databases[DATABASE].DroppedWhileBuilding.indices.tag, undefined);
		});

		it('keeps declared fields when a peer definition recovers an abandoned build', async function () {
			const attributes = [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'tag', type: 'String', indexed: true, description: 'the tag', assignUpdatedTime: true },
			];
			table({ table: 'Recovered', database: DATABASE, schemaDefined: true, attributes });
			const { Recovered } = databases[DATABASE];
			await Recovered.put('r1', { id: 'r1', tag: 'x' });
			await committed('Recovered');
			Recovered.dbisDB.putSync('Recovered/tag', { ...catalogRow('Recovered', 'tag'), indexingFailed: true });
			// a thread whose live table predates the attribute, so the peer's object is the one persisted
			Recovered.attributes.splice(
				Recovered.attributes.findIndex((attribute) => attribute.name === 'tag'),
				1
			);
			createFromPeer('Recovered', [
				['id', 'ID', true],
				['tag', 'String'],
			]);
			await committed('Recovered');
			const row = catalogRow('Recovered', 'tag');
			assert.strictEqual(row.indexingFailed, undefined, 'the recovered build completed');
			assert.strictEqual(row.description, 'the tag');
			assert.strictEqual(row.assignUpdatedTime, true);
		});

		it('stops maintaining an index the declaration no longer has', async function () {
			const declare = (directive) =>
				loadGQLSchema(`
				type Deindexed @table(database: "${DATABASE}") {
					id: ID @primaryKey
					tag: String ${directive}
				}`);
			await declare('@indexed');
			await databases[DATABASE].Deindexed.put('d1', { id: 'd1', tag: 'x' });
			await declare('');
			await committed('Deindexed');
			assert.strictEqual(databases[DATABASE].Deindexed.indices.tag, undefined);
			resetDatabases();
			assert.strictEqual(databases[DATABASE].Deindexed.indices.tag, undefined);
			await databases[DATABASE].Deindexed.put('d2', { id: 'd2', tag: 'x' });
			assert.deepStrictEqual(await searchIds(databases[DATABASE].Deindexed, 'tag', 'x'), ['d1', 'd2']);
		});

		it('keeps maintaining an index when the declaration that drops it fails', async function () {
			const declare = (fields) =>
				table({
					table: 'FailedDeindex',
					database: DATABASE,
					schemaDefined: true,
					attributes: [
						{ name: 'id', type: 'ID', isPrimaryKey: true },
						{ name: 'tag', type: 'String', ...fields },
					],
				});
			declare({ indexed: true });
			const { FailedDeindex } = databases[DATABASE];
			await FailedDeindex.put('f1', { id: 'f1', tag: 'x' });
			await committed('FailedDeindex');
			const catalog = FailedDeindex.dbisDB;
			const put = catalog.put;
			catalog.put = function (key, ...rest) {
				if (key === 'FailedDeindex/tag') throw new Error('injected catalog failure');
				return put.call(this, key, ...rest);
			};
			try {
				assert.throws(() => declare({}), /injected catalog failure/);
			} finally {
				catalog.put = put;
			}
			assert.ok(catalogRow('FailedDeindex', 'tag').indexed, 'the row still declares the index');
			assert.ok(FailedDeindex.indices.tag, 'so this thread still maintains it');
			await FailedDeindex.put('f2', { id: 'f2', tag: 'x' });
			assert.deepStrictEqual(await searchIds(FailedDeindex, 'tag', 'x'), ['f1', 'f2']);
		});

		it('rebuilds an index added back after its records changed unindexed', async function () {
			const declare = (directive) =>
				loadGQLSchema(`
				type Readded @table(database: "${DATABASE}") {
					id: ID @primaryKey
					tag: String ${directive}
				}`);
			await declare('@indexed');
			await databases[DATABASE].Readded.put('a1', { id: 'a1', tag: 'x' });
			await committed('Readded');
			await declare('');
			await databases[DATABASE].Readded.delete('a1');
			// as the cleanup scan purges a tombstone once audit retention passes, leaving the table empty
			await databases[DATABASE].Readded.primaryStore.remove('a1');
			await committed('Readded');
			await declare('@indexed');
			await committed('Readded');
			const { Readded } = databases[DATABASE];
			let entries = 0;
			for (const _entry of Readded.indices.tag.getRange({})) entries++;
			assert.strictEqual(entries, 0, 'the deleted record left no entry behind');
			assert.deepStrictEqual(await searchIds(Readded, 'tag', 'x'), []);
		});

		it('resets a native HNSW plane added back after its records changed unindexed', async function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !getPlaneBinding()) this.skip();
			const declare = (indexed) =>
				table({
					table: 'PlaneReadded',
					database: DATABASE,
					audit: true,
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{
							name: 'vector',
							type: 'Array',
							...(indexed ? { indexed: { type: 'HNSW', nativePlane: true, efConstruction: 200 } } : {}),
						},
					],
				});
			declare(true);
			const { PlaneReadded } = databases[DATABASE];
			for (let i = 1; i <= 5; i++) await PlaneReadded.put(i, { vector: [i, i + 1, i + 2, i + 3] });
			await committed('PlaneReadded');
			const store = PlaneReadded.indices.vector;
			// the plane applies committed writes, and records them in its store, asynchronously
			await waitFor(() => [...store.getRange({})].length >= 5, {
				timeout: 15_000,
				message: 'the plane never published its mappings',
			});
			declare(false);
			await committed('PlaneReadded');
			for (let i = 1; i <= 5; i++) {
				await PlaneReadded.delete(i);
				await PlaneReadded.primaryStore.remove(i);
			}
			declare(true);
			assert.ok(catalogRow('PlaneReadded', 'vector').indexingBuildId, 'the leftover plane state starts a build');
			// the build yields before it clears, so the reopened index can be watched
			const index = PlaneReadded.indices.vector.customIndex;
			let resets = 0;
			index.resetDerivedStorage = function () {
				resets++;
				return Object.getPrototypeOf(this).resetDerivedStorage.call(this);
			};
			await committed('PlaneReadded');
			assert.ok(resets > 0, 'the build reset the plane');
		});
	});
});
