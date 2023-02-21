'use strict';
const test_util = require('../../../../test_utils');
test_util.preTestPrep();

const path = require('path');
const assert = require('assert');
const fs = require('fs-extra');
const env_util = require('../../../../../utility/lmdb/environmentUtility');
const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const get_table_size = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbGetTableSize');

describe('Test getLMDBStats function', function () {
	let env = undefined;
	let txn_env;
	const LMDB_TEST_FOLDER_NAME = 'lmdbTest';
	const BASE_TEST_PATH = path.join(test_util.getMockLMDBPath(), LMDB_TEST_FOLDER_NAME);
	const BASE_TXN_PATH = path.join(test_util.getMockLMDBPath(), 'transactions', LMDB_TEST_FOLDER_NAME);
	const TEST_ENVIRONMENT_NAME = 'test';
	const ID_DBI_NAME = 'id';
	const TABLE_RESULT = {
		schema: LMDB_TEST_FOLDER_NAME,
		name: TEST_ENVIRONMENT_NAME,
		hash_attribute: ID_DBI_NAME,
	};

	before(async function () {
		global.lmdb_map = undefined;
		await fs.remove(test_util.getMockLMDBPath());
		await fs.mkdirp(BASE_TEST_PATH);
		await fs.mkdirp(BASE_TXN_PATH);
		env = await env_util.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
		await env_util.createDBI(env, ID_DBI_NAME);

		txn_env = await env_util.createEnvironment(BASE_TXN_PATH, TEST_ENVIRONMENT_NAME, true);
		await env_util.createDBI(txn_env, 'timestamp');
	});

	after(async function () {
		await env.close();
		await txn_env.close();

		global.lmdb_map = undefined;
		await fs.remove(test_util.getMockLMDBPath());
	});

	it('getLMDBStats, test nominal case', async function () {
		let table = test_util.deepClone(TABLE_RESULT);
		let results = await get_table_size(table);
		assert(results.schema === table.schema);
		assert(results.table === table.name);
		assert(results.table_size !== undefined);
		assert(results.record_count === 0);
		assert(results.transaction_log_size !== undefined);
		assert(results.transaction_log_record_count === 0);
	});
});
