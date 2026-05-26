'use strict';
const testUtils = require('../../../../testUtils.js');
testUtils.preTestPrep();

const path = require('path');
const assert = require('assert');
const fs = require('fs-extra');
const env_util = require('#src/utility/lmdb/environmentUtility');
const { lmdbGetTableSize } = require('#src/dataLayer/harperBridge/lmdbBridge/lmdbUtility/lmdbGetTableSize');

describe('Test getLMDBStats function', function () {
	let env = undefined;
	let txn_env;
	let mockTable;
	const LMDB_TEST_FOLDER_NAME = 'lmdbTest';
	const BASE_TEST_PATH = path.join(testUtils.setupTestDBPath(), LMDB_TEST_FOLDER_NAME);
	const BASE_TXN_PATH = path.join(testUtils.setupTestDBPath(), 'transactions', LMDB_TEST_FOLDER_NAME);
	const TEST_ENVIRONMENT_NAME = 'test';
	const ID_DBI_NAME = 'id';

	before(async function () {
		global.lmdb_map = undefined;
		await fs.remove(testUtils.setupTestDBPath());
		await fs.mkdirp(BASE_TEST_PATH);
		await fs.mkdirp(BASE_TXN_PATH);
		env = await env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
		const primaryStore = await env_util.createDBI(env, ID_DBI_NAME);

		txn_env = await env_util.createEnvironment(BASE_TXN_PATH, TEST_ENVIRONMENT_NAME, true);
		const auditStore = await env_util.createDBI(txn_env, 'timestamp');

		mockTable = {
			databaseName: LMDB_TEST_FOLDER_NAME,
			tableName: TEST_ENVIRONMENT_NAME,
			primaryStore,
			auditStore,
		};
	});

	after(async function () {
		await env.close();
		await txn_env.close();

		global.lmdb_map = undefined;
		await fs.remove(testUtils.setupTestDBPath());
	});

	it('getLMDBStats, test nominal case', () => {
		const results = lmdbGetTableSize(mockTable);
		assert(results.schema === mockTable.databaseName);
		assert(results.table === mockTable.tableName);
		assert(results.tableSize !== undefined);
		assert(results.recordCount === 0);
		assert(results.transactionLogSize !== undefined);
		assert(results.transactionLogRecordCount === 0);
	});
});
