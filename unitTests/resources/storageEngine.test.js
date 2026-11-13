require('../testUtils');
const assert = require('node:assert');
const { join } = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { setupTestDBPath } = require('../testUtils');
const { table, readMetaDb, databaseStorageEngines, getDatabases } = require('#src/resources/databases');
const { describeTable } = require('#src/dataLayer/schemaDescribe');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const configuredEngine = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';

describe('the opened storage engine of a table and a database', () => {
	let lmdbDir;
	before(() => {
		setupTestDBPath();
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
});
