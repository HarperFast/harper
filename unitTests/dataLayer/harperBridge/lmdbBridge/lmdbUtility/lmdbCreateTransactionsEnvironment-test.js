'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
const path = require('path');
const TRANSACTIONS_NAME = 'transactions';
const BASE_PATH = test_utils.getMockLMDBPath();
const BASE_TRANSACTIONS_PATH = path.join(BASE_PATH, TRANSACTIONS_NAME);

const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const lmdb_create_txn_envs = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/lmdbCreateTransactionsAuditEnvironment');
const LMDB_ERRORS = require('../../../../commonTestErrors').LMDB_ERRORS_ENUM;
const assert = require('assert');
const fs = require('fs-extra');

const CREATE_TABLE_OBJ = {
	schema: 'dev',
	table: 'test',
	hash_attribute: 'id',
};

describe('test lmdbCreateTransactionsEnvironment module', () => {
	before(async () => {
		await fs.remove(BASE_PATH);
	});

	after(() => {});

	describe('test lmdbCreateTransactionsEnvironment function', () => {
		before(async () => {
			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
			await fs.mkdirp(BASE_TRANSACTIONS_PATH);
		});

		after(async () => {
			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('test adding a transaction environment', async () => {
			let transaction_path = path.join(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.schema);
			let expected_txn_dbis = ['hash_value', 'timestamp', 'user_name'];

			await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[transaction_path, CREATE_TABLE_OBJ.table, true],
				LMDB_ERRORS.INVALID_BASE_PATH
			);

			assert.deepStrictEqual(global.lmdb_map, Object.create(null));

			await test_utils.assertErrorAsync(lmdb_create_txn_envs, [CREATE_TABLE_OBJ], undefined);

			let txn_env = await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[transaction_path, CREATE_TABLE_OBJ.table, true],
				undefined
			);

			assert.notDeepStrictEqual(txn_env, undefined);

			let txn_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [txn_env], undefined);
			assert.deepStrictEqual(txn_dbis, expected_txn_dbis);

			assert.deepStrictEqual(global.lmdb_map[`txn.${CREATE_TABLE_OBJ.schema}.${CREATE_TABLE_OBJ.table}`], txn_env);

			await txn_env.close();
		});
	});
});
