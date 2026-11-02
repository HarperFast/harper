// harper#3225: the LMDB→RocksDB migration must copy a keyless table's records even when its bare
// `<table>/` catalog row has lost isPrimaryKey.
const fs = require('fs-extra');
const assert = require('node:assert');
const path = require('path');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { get: envGet } = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { setupTestDBPath } = require('../testUtils');
const copyDB = require('#src/bin/copyDb');
const { RocksDatabase } = require('@harperfast/rocksdb-js');

const isLMDB = (process.env.HARPER_STORAGE_ENGINE || envGet(CONFIG_PARAMS.STORAGE_ENGINE)) === 'lmdb';

describe('migration: a keyless table whose bare row lacks isPrimaryKey (harper#3225)', function () {
	const tableName = 'KeylessMigrate';
	let rootPath, targetPath;
	const ids = [];

	before(async function () {
		if (!isLMDB) return this.skip();
		rootPath = setupTestDBPath();
		setMainIsWorker(true);
		const Keyless = table({ table: tableName, database: 'kmtest', attributes: [{ name: 'name' }] });
		ids.push(await Keyless.post({ name: 'first' }), await Keyless.post({ name: 'second' }));
		const bareKey = `${tableName}/`;
		const row = { ...Keyless.dbisDB.getSync(bareKey) };
		assert(row.tableId, 'the copied row must carry the original descriptor');
		delete row.isPrimaryKey;
		delete row.is_hash_attribute;
		Keyless.dbisDB.putSync(bareKey, row);
		if (Keyless.dbisDB.committed) await Keyless.dbisDB.committed;

		targetPath = path.join(rootPath, 'rocks-migrated-keyless', 'kmtest');
		await fs.remove(targetPath);
		await copyDB.copyDbToRocks(Keyless.primaryStore.rootStore, 'kmtest', targetPath);
	});

	after(async function () {
		if (rootPath) await fs.remove(path.join(rootPath, 'rocks-migrated-keyless'));
	});

	it('copies the primary store and reports its records', function () {
		const store = RocksDatabase.open(targetPath, { name: `${tableName}/`, encoding: false });
		try {
			for (const id of ids) assert(store.getBinarySync(id), `record ${id} missing from the migrated store`);
		} finally {
			store.close();
		}
		const report = copyDB.verifyMigratedDatabase(targetPath);
		assert.strictEqual(report[`${tableName}/`]?.records, ids.length, JSON.stringify(report));
	});
});
