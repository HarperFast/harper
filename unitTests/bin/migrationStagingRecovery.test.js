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
const { setupTestDBPath } = require('../testUtils');
const copyDB = require('#src/bin/copyDb');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { RecordEncoder } = require('#src/resources/RecordEncoder');

const isLMDB = (process.env.HARPER_STORAGE_ENGINE || envGet(CONFIG_PARAMS.STORAGE_ENGINE)) === 'lmdb';

describe('migration: staging directory recovery (#2012)', function () {
	let rootPath, baseDir, targetPath, stagingPath, Tbl;

	before(async function () {
		// this.skip() (not a bare return in the describe body) so the gate is visible as pending
		if (!isLMDB) return this.skip();
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
		if (baseDir) await fs.remove(baseDir);
	});

	it('a failed migration removes its staging dir and leaves no artifact at the target path', async function () {
		// A source whose dbi iteration throws immediately — the staging dir is created before the
		// copy loop starts, so the catch path must clean it up and leave targetPath absent.
		const brokenSource = {
			dbisDb: {
				useReadTransaction() {
					throw new Error('injected migration failure');
				},
			},
		};
		await assert.rejects(
			() => copyDB.migrateDatabaseToRocks(brokenSource, 'stagetest', targetPath),
			/injected migration failure/
		);
		assert.strictEqual(fs.existsSync(stagingPath), false, 'staging dir must be removed on failure');
		assert.strictEqual(fs.existsSync(targetPath), false, 'no artifact may appear at the target path on failure');
		// the LMDB source is untouched and still serves reads
		assert.strictEqual((await Tbl.get('a')).name, 'alpha');
	});

	it('promotion replaces stale staging and a stale partial RocksDB at the target path', async function () {
		// Simulate the "both artifacts present after an interrupted run" restart state: a junk
		// leftover staging dir AND a partial (unreadable) RocksDB already at the real path.
		await fs.outputFile(path.join(stagingPath, 'junk'), 'stale staging from a failed attempt');
		await fs.outputFile(path.join(targetPath, 'CURRENT'), 'MANIFEST-000001\n');
		await fs.outputFile(path.join(targetPath, 'MANIFEST-000001'), 'partial');

		await copyDB.migrateDatabaseToRocks(Tbl.primaryStore.rootStore, 'stagetest', targetPath);

		assert.strictEqual(fs.existsSync(stagingPath), false, 'staging dir must not survive promotion');

		// Opening the renamed directory also guards the close-all-handles contract: a handle
		// leaked on the staging path would still hold the RocksDB LOCK for this store.
		const cf = RocksDatabase.open(targetPath, {
			name: 'StagedRec/',
			encoder: { Encoder: RecordEncoder },
			sharedStructuresKey: Symbol.for('structures'),
		});
		cf.encoder.isRocksDB = true;
		try {
			for (const id of ['a', 'b']) {
				const decoded = cf.encoder.decode(cf.getBinarySync(id));
				assert(decoded?.value, `record ${id} missing after promotion`);
				assert(decoded.version > 0, `record ${id} lost its version`);
			}
		} finally {
			cf.close();
		}
	});

	it('verifyMigratedDatabase reports zero unversioned records for a clean migration', function () {
		const report = copyDB.verifyMigratedDatabase(targetPath);
		assert.deepStrictEqual(report['StagedRec/'], { records: 2, unversioned: 0 });
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
