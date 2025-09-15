require('../test_utils');
const fs = require('fs-extra');
const assert = require('assert');
const path = require('path');
const sinon = require('sinon');
const env_mgr = require('../../utility/environment/environmentManager');
const { table } = require('../../resources/databases');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const config_utils = require('../../config/configUtils');
const copyDB = require('../../bin/copyDb');
const { resetDatabases } = require('../../resources/databases');

describe('Test database copy and compact', () => {
	const sandbox = sinon.createSandbox();
	let TestTable;
	let storage_path;
	let storage_before_test;
	let root_before_test;
	let stat_before_compact;
	let console_error_spy;
	let console_log_spy;
	let update_config_stub;
	let test_db_path;
	let test_db_backup_path;

	before(async function () {
		console_error_spy = sandbox.spy(console, 'error');
		console_log_spy = sandbox.spy(console, 'log');
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
		env_mgr.setProperty('rootPath', root_before_test);
	});

	it('Test copyDB copies and compacts a DB', async () => {
		const compacted_db = path.join(storage_path, 'db-copy.mdb');
		await copyDB.copyDb('copy-test', compacted_db);
		await TestTable.put(105, {
			// should not be written
			id: 105,
			name: 'Should not be written',
			about: 'about',
			notIndexed: 'I am a non-indexed value',
		});
		const stat_after = await fs.stat(compacted_db);
		assert((stat_after.size / stat_before_compact.size) * 100 < 10);
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
		assert(update_config_stub.called);
		assert(!console_error_spy.called);
		assert((stat_after.size / stat_before_compact.size) * 100 < 10);
	});

	it('Test compactOnStart compacts and overwrites DB and keeps backups', async () => {
		env_mgr.setProperty('storage_compactOnStartKeepBackup', true);
		await copyDB.compactOnStart();
		const stat_after = await fs.stat(path.join(storage_path, 'copy-test.mdb'));
		assert(update_config_stub.called);
		assert(!console_error_spy.called);
		assert(stat_after.size < 200000);
		assert(await fs.exists(path.join(storage_path, 'backup', 'copy-test.mdb')));
	});
});
