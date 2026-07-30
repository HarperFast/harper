// Restart-safety guards for the staged LMDB→RocksDB migration (harper#2012 review):
// a failed migration must never leave a partial RocksDB at the database's real path, because on
// the next boot both <db>.mdb and <db>/ are discovered and whichever binds last wins — a partial
// RocksDB that wins gets promoted (flag cleared) while the intact LMDB is abandoned. The
// migration therefore stages into <db>.migrating (excluded from discovery) and atomically
// renames after verification, replacing any stale artifact at the real path.
const fs = require('fs-extra');
const assert = require('node:assert');
const path = require('path');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { get: envGet } = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS, MIGRATING_DIR_SUFFIX } = require('#src/utility/hdbTerms');

describe('migration: staging directory recovery (#2012)', function () {
	if ((process.env.HARPER_STORAGE_ENGINE || envGet(CONFIG_PARAMS.STORAGE_ENGINE)) !== 'lmdb') return;
	const { setupTestDBPath } = require('../testUtils');
	const copyDB = require('#src/bin/copyDb');
	const { RocksDatabase } = require('@harperfast/rocksdb-js');
	const { RecordEncoder, RecordObject } = require('#src/resources/RecordEncoder');
	const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');

	let rootPath, baseDir, targetPath, stagingPath, Tbl;

	before(async function () {
		rootPath = setupTestDBPath();
		setMainIsWorker(true);
		Tbl = table({
			table: 'StagedRec',
			database: 'stagetest',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		await Tbl.put({ id: 'a', name: 'alpha' });
		await Tbl.put({ id: 'b', name: 'beta' });

		baseDir = path.join(rootPath, 'rocks-staging-recovery');
		targetPath = path.join(baseDir, 'stagetest');
		stagingPath = targetPath + MIGRATING_DIR_SUFFIX;
		await fs.remove(baseDir);
	});

	after(async function () {
		await fs.remove(baseDir);
	});

	it('promotion replaces stale staging and a stale partial RocksDB at the target path', async function () {
		// Simulate the "both artifacts present after an interrupted run" restart state: a junk
		// leftover staging dir AND a partial (unreadable) RocksDB already at the real path.
		await fs.outputFile(path.join(stagingPath, 'junk'), 'stale staging from a failed attempt');
		await fs.outputFile(path.join(targetPath, 'CURRENT'), 'MANIFEST-000001\n');
		await fs.outputFile(path.join(targetPath, 'MANIFEST-000001'), 'partial');

		// The promotion sequence migrateOnStart runs per database.
		await fs.remove(stagingPath);
		await copyDB.copyDbToRocks(Tbl.primaryStore.rootStore, 'stagetest', stagingPath);
		await fs.remove(targetPath);
		await fs.rename(stagingPath, targetPath);

		assert.strictEqual(fs.existsSync(stagingPath), false, 'staging dir must not survive promotion');

		// Opening the renamed directory also guards the close-all-handles contract: a handle
		// leaked on the staging path would still hold the RocksDB LOCK for this store.
		const root = RocksDatabase.open(targetPath, {});
		const cf = new PrimaryRocksDatabase(targetPath, {
			name: 'StagedRec/',
			encoder: { Encoder: RecordEncoder },
			sharedStructuresKey: Symbol.for('structures'),
		}).open();
		cf.initStore(root);
		try {
			for (const id of ['a', 'b']) {
				const entry = cf.getEntry(id);
				assert(entry?.value, `record ${id} missing after promotion`);
				assert(entry.value instanceof RecordObject, `record ${id} lost its record prototype`);
				assert(entry.version > 0, `record ${id} lost its version`);
			}
		} finally {
			cf.close();
			root.close();
		}
	});

	it('database discovery ignores *.migrating staging directories', async function () {
		const { getDatabases, resetDatabases } = require('#src/resources/databases');
		const databasesDir = path.join(rootPath, 'database');
		const ghostDir = path.join(databasesDir, 'ghost' + MIGRATING_DIR_SUFFIX);
		// Rocks markers that would otherwise make discovery open it as a database
		await fs.outputFile(path.join(ghostDir, 'CURRENT'), 'MANIFEST-000001\n');
		await fs.outputFile(path.join(ghostDir, 'MANIFEST-000001'), 'partial');
		try {
			resetDatabases();
			const databases = getDatabases();
			assert.strictEqual(
				databases['ghost' + MIGRATING_DIR_SUFFIX],
				undefined,
				'staging dir must not be discovered as a database'
			);
		} finally {
			await fs.remove(ghostDir);
			resetDatabases();
		}
	});
});
