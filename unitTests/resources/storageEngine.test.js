require('../testUtils');
const assert = require('node:assert');
const { join } = require('node:path');
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { setupTestDBPath } = require('../testUtils');
const {
	table,
	database,
	readMetaDb,
	databaseStorageEngines,
	getDatabases,
	closeDatabase,
	resetDatabases,
} = require('#src/resources/databases');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const { describeTable } = require('#src/dataLayer/schemaDescribe');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const configuredEngine = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';

describe('the opened storage engine of a table and a database', () => {
	let lmdbDir;
	let testRoot;
	before(() => {
		testRoot = setupTestDBPath();
		setMainIsWorker(true);
	});
	after(() => {
		if (lmdbDir) rmSync(lmdbDir, { recursive: true, force: true });
	});

	it('reports the configured engine for a database created now, in Table.storageEngine and describe_table', async () => {
		const Created = table({
			table: 'EngineCreated',
			database: 'engine_created',
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		assert.strictEqual(Created.storageEngine, configuredEngine);
		assert.deepStrictEqual([...databaseStorageEngines('engine_created')], [configuredEngine]);
		const description = await describeTable({ database: 'engine_created', table: 'EngineCreated' });
		assert.strictEqual(description.engine, configuredEngine);
	});

	it('reports lmdb for an existing .mdb root whatever storage.engine says, before it has any table', () => {
		lmdbDir = mkdtempSync(join(tmpdir(), 'harper-engine-'));
		readMetaDb(join(lmdbDir, 'engine_legacy.mdb'), null, 'engine_legacy');
		assert.ok(Object.getOwnPropertyNames(getDatabases()).includes('engine_legacy'));
		assert.deepStrictEqual([...databaseStorageEngines('engine_legacy')], ['lmdb']);
		assert.deepStrictEqual([...databaseStorageEngines('engine_absent')], []);
	});

	it('reports a root opened by create_database before its first table', () => {
		database({ database: 'engine_bare', table: undefined });
		assert.deepStrictEqual(Object.keys(getDatabases().engine_bare ?? {}), []);
		assert.deepStrictEqual([...databaseStorageEngines('engine_bare')], [configuredEngine]);
	});

	it('reports a shared root under every database name that loads it, not only the first', async () => {
		const storageRoot = join(testRoot, 'engine-alias');
		mkdirSync(storageRoot, { recursive: true });
		env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, storageRoot);
		env.setProperty(terms.CONFIG_PARAMS.DATABASES, {});
		resetDatabases();
		const Shared = table({
			database: 'engine_physical',
			table: 'Shared',
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }],
		});
		await Shared.dbisDB.committed;
		await closeDatabase('engine_physical');
		env.setProperty(terms.CONFIG_PARAMS.DATABASES, { engine_alias: { path: storageRoot } });
		try {
			const loaded = resetDatabases();
			assert.strictEqual(
				loaded.engine_alias.Shared.primaryStore.rootStore,
				loaded.engine_physical.Shared.primaryStore.rootStore
			);
			assert.deepStrictEqual([...databaseStorageEngines('engine_physical')], [configuredEngine]);
			assert.deepStrictEqual([...databaseStorageEngines('engine_alias')], [configuredEngine]);
		} finally {
			await closeDatabase('engine_alias');
			await closeDatabase('engine_physical');
			env.setProperty(terms.CONFIG_PARAMS.DATABASES, {});
			setupTestDBPath();
		}
	});
});
