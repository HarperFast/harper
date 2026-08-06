const fs = require('fs-extra');
const assert = require('assert');
const path = require('path');
const sinon = require('sinon');
const env_mgr = require('#src/utility/environment/environmentManager');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const config_utils = require('#src/config/configUtils');
const copyDB = require('#src/bin/copyDb');
const { resetDatabases } = require('#src/resources/databases');
const { get: envGet } = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

describe('Test database copy and compact', () => {
	const sandbox = sinon.createSandbox();
	let TestTable;
	let storage_path;
	let storage_before_test;
	let stat_before_compact;
	let console_error_spy;
	let update_config_stub;
	let test_db_path;
	let test_db_backup_path;
	// HARPER_STORAGE_ENGINE is how `test:unit:lmdb` selects the engine; gating on the config value
	// alone (unset under mocha) skipped this whole suite in every run.
	if ((process.env.HARPER_STORAGE_ENGINE || envGet(CONFIG_PARAMS.STORAGE_ENGINE)) !== 'lmdb') return;
	before(async function () {
		console_error_spy = sandbox.spy(console, 'error');
		sandbox.spy(console, 'log');
		update_config_stub = sandbox.stub(config_utils, 'updateConfigValue');
		storage_path = path.resolve(__dirname, '../envDir/copyTest');
		storage_before_test = env_mgr.get('storage_path');
		test_db_path = path.join(storage_path, 'copy-test.mdb');
		test_db_backup_path = path.resolve(__dirname, '../envDir/copy-test.mdb');
		delete databases.copyTest; // delete/cleanup the wrong db from memory
		env_mgr.setProperty('storage_path', storage_path);
		env_mgr.setProperty('rootPath', storage_path);
		setMainIsWorker(true);
		let value = '';
		for (let x = 0; x < 100; x++) {
			value += 'Duke is a male title either of a monarch ruling over a duchy, or of a member of royalty, or nobility.';
		}

		TestTable = table({
			table: 'TestTable',
			database: 'copy-test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'about', indexed: true },
				{ name: 'notIndexed' },
			],
		});

		let last;
		for (let i = 0; i < 100; i++) {
			last = TestTable.put({
				id: i,
				name: 'His Royal Highness Duke of Denver Harper DB ',
				about: value,
				notIndexed: 'I am a non-indexed value',
			});
		}

		await last;

		stat_before_compact = await fs.stat(test_db_path);
		await fs.copy(test_db_path, test_db_backup_path);
	});

	beforeEach(async () => {
		sandbox.resetHistory();
		await fs.copy(test_db_backup_path, test_db_path, { overwrite: true });
		resetDatabases();
		delete databases.copyTest; // delete/cleanup the wrong db from memory
	});

	after(async () => {
		sandbox.restore();
		await fs.remove(storage_path);
		await fs.remove(test_db_backup_path);
		env_mgr.setProperty('storage_path', storage_before_test);
	});

	it('Test copyDB copies and compacts a DB', async () => {
		const compacted_db = path.join(storage_path, 'db-copy.mdb');
		await copyDB.copyDb('copy-test', compacted_db, { blobs: 'copy' });
		await TestTable.put(105, {
			// should not be written
			id: 105,
			name: 'Should not be written',
			about: 'about',
			notIndexed: 'I am a non-indexed value',
		});
		const stat_after = await fs.stat(compacted_db);
		// The copy carries the audit log now that it goes to the target environment instead of back
		// into the source (harper#2048), so it is about the size of the source rather than a fraction
		// of it — the size drop this used to assert was the audit log being silently dropped.
		assert(
			stat_after.size <= stat_before_compact.size,
			`Compacted copy (${stat_after.size}) should not exceed the source (${stat_before_compact.size})`
		);
		assert(!(await TestTable.get(105)));
		let matches = [];
		for await (let entry of TestTable.search([{ name: 'about', value: 'about' }])) matches.push(entry);
		assert.equal(matches.length, 0);
		await fs.remove(compacted_db);
		await fs.remove(compacted_db + '-lock');
	});

	it('Test compactOnStart compacts and overwrites DB', async () => {
		await copyDB.compactOnStart();
		const stat_after = await fs.stat(path.join(storage_path, 'copy-test.mdb'));
		assert(update_config_stub.called, 'updateConfigValue should be called');
		assert(!console_error_spy.called, 'console.error should not be called');
		assert(
			stat_after.size <= stat_before_compact.size,
			'after size ' + stat_after.size + ' should not exceed before size ' + stat_before_compact.size
		);
		let readable = 0;
		for (let i = 0; i < 100; i++) if ((await TestTable.get(i))?.notIndexed) readable++;
		assert.equal(readable, 100, 'every record should still be readable after compaction');
	});

	it('Test compactOnStart compacts and overwrites DB and keeps backups', async () => {
		env_mgr.setProperty('storage_compactOnStartKeepBackup', true);
		await copyDB.compactOnStart();
		const stat_after = await fs.stat(path.join(storage_path, 'copy-test.mdb'));
		assert(update_config_stub.called);
		assert(!console_error_spy.called);
		assert(stat_after.size <= stat_before_compact.size);
		assert(await fs.exists(path.join(storage_path, 'backup', 'copy-test.mdb')));
	});
});
