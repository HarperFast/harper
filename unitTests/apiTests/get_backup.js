const { callOperation, removeAllSchemas } = require('./utility');
const crypto = require('crypto');
const { promisify } = require('util');
const sleep = promisify(setTimeout);
const { join } = require('path');
const { pipeline } = require('stream/promises');
const { writeFileSync, mkdirpSync, createWriteStream } = require('fs-extra');
const { assert, expect } = globalThis.chai || require('chai');
const { openEnvironment } = require('../../utility/lmdb/environmentUtility');
const UNIT_TEST_DIR = __dirname;
const ENV_DIR_NAME = 'envDir';

describe('test backup operation', () => {
	beforeEach(async () => {});

	it('get backup', async () => {
		// get a backup snapshot
		let response = await callOperation({
			operation: 'get_backup',
			schema: 'system',
			table: 'hdb_user',
		});
		expect(response.status).to.eq(200);
		// make a path to put it
		let lmdb_path = join(UNIT_TEST_DIR, ENV_DIR_NAME, process.pid.toString());
		mkdirpSync(lmdb_path);
		// download it to a new database file (here with streaming since that is what we would want in real life)
		await pipeline(response.body, createWriteStream(join(lmdb_path, 'restore.mdb')));
		// test that we can open it and iterate through it
		let env = await openEnvironment(lmdb_path, 'restore');
		let user_entries = Array.from(env.dbis.username.getRange({ start: true }));
		expect(user_entries.length > 0).to.be.true;
		expect(user_entries.every((user_entry) => user_entry.key === user_entry.value.username)).to.be.true;
	});
});
