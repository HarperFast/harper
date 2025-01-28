const { callOperation, removeAllSchemas } = require('./utility');
const { promisify } = require('util');
const { join } = require('path');
const { pipeline } = require('stream/promises');
const { readMetaDb, databases } = require('../../resources/databases');
const { writeFileSync, mkdirpSync, createWriteStream } = require('fs-extra');
const { assert, expect } = globalThis.chai || require('chai');
const { openEnvironment } = require('../../utility/lmdb/environmentUtility');
const UNIT_TEST_DIR = __dirname;
const ENV_DIR_NAME = 'envDir';

describe('test backup operation', () => {
	before(async () => {
		const { setupTestApp } = await import('./setupTestApp.mjs');
		await setupTestApp();
	});
	it('get backup of system tables', async () => {
		// get a backup snapshot
		let response = await callOperation({
			operation: 'get_backup',
			database: 'system',
			tables: ['hdb_user', 'hdb_role'],
		});
		expect(response.status).to.eq(200);
		// make a path to put it
		let lmdb_path = join(UNIT_TEST_DIR, ENV_DIR_NAME, process.pid.toString());
		mkdirpSync(lmdb_path);
		lmdb_path = join(lmdb_path, 'restore.mdb');
		// download it to a new database file (here with streaming since that is what we would want in real life)
		await pipeline(response.body, createWriteStream(lmdb_path));
		// test that we can open it and iterate through it
		readMetaDb(lmdb_path, null, 'system_restore');
		assert.equal(databases.system_restore.hdb_user.primaryStore.path, lmdb_path);
		let users = databases.system_restore.hdb_user.search({});
		let user_entries = [];
		for await (let user of users) {
			user_entries.push(user);
		}
		expect(user_entries.length > 0).to.be.true;
	});
	it('get backup of data tables with audit', async () => {
		// get a backup snapshot
		let response = await callOperation({
			operation: 'get_backup',
			tables: ['VariedProps'],
			include_audit: true,
		});
		expect(response.status).to.eq(200);
		// make a path to put it
		let lmdb_path = join(UNIT_TEST_DIR, ENV_DIR_NAME, process.pid.toString());
		mkdirpSync(lmdb_path);
		lmdb_path = join(lmdb_path, 'data_restore.mdb');
		// download it to a new database file (here with streaming since that is what we would want in real life)
		await pipeline(response.body, createWriteStream(lmdb_path));
		// test that we can open it and iterate through it
		readMetaDb(lmdb_path, null, 'data_restore');
		let record_search = databases.data_restore.VariedProps.search({});
		let records = [];
		for await (let record of record_search) {
			records.push(record);
		}
		expect(records.length > 10).to.be.true;
		let record_history = [];
		for await (let entry of databases.data_restore.VariedProps.getHistory()) {
			expect(entry.localTime > 1695130929324).to.be.true;
			expect(entry.version > 1695130929324).to.be.true;
			record_history.push(entry);
		}
		expect(records.length > 10).to.be.true;
	});

	it('get backup of system database', async () => {
		// get a backup snapshot
		let response = await callOperation({
			operation: 'get_backup',
			schema: 'system',
		});
		expect(response.status).to.eq(200);
		// make a path to put it
		let lmdb_path = join(UNIT_TEST_DIR, ENV_DIR_NAME, process.pid.toString());
		mkdirpSync(lmdb_path);
		lmdb_path = join(lmdb_path, 'full_restore.mdb');
		// download it to a new database file (here with streaming since that is what we would want in real life)
		await pipeline(response.body, createWriteStream(lmdb_path));
		// test that we can open it and iterate through it
		readMetaDb(lmdb_path, null, 'system_restore2');
		assert.equal(databases.system_restore2.hdb_user.primaryStore.path, lmdb_path);
		let users = databases.system_restore2.hdb_user.search({});
		let user_entries = [];
		for await (let user of users) {
			user_entries.push(user);
		}
		expect(user_entries.length > 0).to.be.true;
	});
});
