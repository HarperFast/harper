'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const path = require('path');
const TRANSACTIONS_NAME = 'transactions';
const BASE_PATH = test_utils.getMockLMDBPath();
const BASE_TRANSACTIONS_PATH = path.join(BASE_PATH, TRANSACTIONS_NAME, 'dev');

const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const lmdb_create_txn_envs = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbCreateTransactionsEnvironment');
const lmdb_write_txn = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbWriteTransaction');
const common = require('../../../../../utility/lmdb/commonUtility');
const fs = require('fs-extra');
const search_util = require('../../../../../utility/lmdb/searchUtility');

const CreateTableObject = require('../../../../../data_layer/CreateTableObject');
const InsertObject = require('../../../../../data_layer/InsertObject');
const InsertRecordsResponseObject = require('../../../../../utility/lmdb/InsertRecordsResponseObject');
const DeleteTransactionsBeforeResults = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/DeleteTransactionsBeforeResults');
const DeleteBeforeObject = require('../../../../../data_layer/DeleteBeforeObject');
const delete_txn_logs_before = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbDeleteTransactionLogsBefore');
const rw_delete_txn_logs_before = rewire(
	'../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbDeleteTransactionLogsBefore'
);
const delete_txns_function = rw_delete_txn_logs_before.__get__('deleteTransactions');
const assert = require('assert');

const CREATE_TABLE_OBJ = new CreateTableObject('dev', 'test', 'id');
const INSERT_RECORDS = [
	{ id: 1, name: 'Penny' },
	{ id: 2, name: 'Kato', age: '6' },
	{ id: 3, name: 'Riley', age: '7' },
	{ id: 'blerrrrr', name: 'Rosco' },
];
let INSERT_HASHES = [1, 2, 3, 'blerrrrr'];

const HDB_USER = {
	username: 'kyle',
};

describe('test lmdbDeleteTransactionLogsBefore module', () => {
	before(async () => {
		await fs.remove(BASE_PATH);
	});

	describe('test deleteTransactions function', () => {
		beforeEach(async () => {
			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
			await fs.mkdirp(BASE_PATH);

			await lmdb_create_txn_envs(CREATE_TABLE_OBJ);
		});

		afterEach(async () => {
			let env1 = await environment_utility.openEnvironment(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.table, true);
			await env1.close();

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('test deleting the first 1000 txns', async () => {
			let m_times = await createTransactions(5000);
			let env = await environment_utility.openEnvironment(BASE_TRANSACTIONS_PATH, 'test', true);
			let stat = environment_utility.statDBI(env, 'timestamp');
			assert.deepStrictEqual(stat.entryCount, 5000);
			let results = await delete_txns_function(env, m_times[1000]);
			let expected_results = new DeleteTransactionsBeforeResults(m_times[0], m_times[999], 1000);
			assert.deepStrictEqual(results, expected_results);

			let iterate_results = search_util.iterateDBI(env, 'timestamp');
			let x = 1000;
			Object.keys(iterate_results).forEach((result) => {
				assert.deepStrictEqual(result, m_times[x++].toString());
			});

			iterate_results = search_util.iterateDBI(env, 'user_name');
			x = 1000;
			Object.values(iterate_results)[0].forEach((result) => {
				assert.deepStrictEqual(result, m_times[x++]);
			});

			iterate_results = search_util.iterateDBI(env, 'hash_value');
			x = 1000;
			Object.values(iterate_results)[0].forEach((result) => {
				assert.deepStrictEqual(result, m_times[x++]);
			});
		});

		it('test deleting when there are no txns', async () => {
			let env = await environment_utility.openEnvironment(BASE_TRANSACTIONS_PATH, 'test', true);
			let results = await delete_txns_function(env, common.getMicroTime());
			assert.deepStrictEqual(results, new DeleteTransactionsBeforeResults());

			let iterate_results = search_util.iterateDBI(env, 'timestamp');
			assert.deepStrictEqual(iterate_results, Object.create(null));

			iterate_results = search_util.iterateDBI(env, 'user_name');
			assert.deepStrictEqual(iterate_results, Object.create(null));

			iterate_results = search_util.iterateDBI(env, 'hash_value');
			assert.deepStrictEqual(iterate_results, Object.create(null));
		});

		it('test deleting with an timestamp that resolves no entries', async () => {
			let m_times = await createTransactions(5000);

			let env = await environment_utility.openEnvironment(BASE_TRANSACTIONS_PATH, 'test', true);
			let results = await delete_txns_function(env, m_times[0] - 1);
			let expected_results = new DeleteTransactionsBeforeResults(undefined, undefined, 0);
			assert.deepStrictEqual(results, expected_results);

			let iterate_results = search_util.iterateDBI(env, 'timestamp');
			let x = 0;
			Object.keys(iterate_results).forEach((result) => {
				assert.deepStrictEqual(result, m_times[x++].toString());
			});

			iterate_results = search_util.iterateDBI(env, 'user_name');
			x = 0;
			Object.values(iterate_results)[0].forEach((result) => {
				assert.deepStrictEqual(result, m_times[x++]);
			});

			iterate_results = search_util.iterateDBI(env, 'hash_value');
			x = 0;
			Object.values(iterate_results)[0].forEach((result) => {
				assert.deepStrictEqual(result, m_times[x++]);
			});
		});

		it('test deleting with an timestamp that deletes all entries', async () => {
			let m_times = await createTransactions(5000);

			let env = await environment_utility.openEnvironment(BASE_TRANSACTIONS_PATH, 'test', true);
			let results = await delete_txns_function(env, m_times[4999] + 1);
			let expected_results = new DeleteTransactionsBeforeResults(m_times[0], m_times[4999], 5000);
			assert.deepStrictEqual(results, expected_results);

			let iterate_results = search_util.iterateDBI(env, 'timestamp');
			assert.deepStrictEqual(iterate_results, Object.create(null));

			iterate_results = search_util.iterateDBI(env, 'user_name');
			assert.deepStrictEqual(iterate_results, Object.create(null));

			iterate_results = search_util.iterateDBI(env, 'hash_value');
			assert.deepStrictEqual(iterate_results, Object.create(null));
		});
	});

	describe('test deleteTransactionLogsBefore function', () => {
		beforeEach(async () => {
			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
			await fs.mkdirp(BASE_PATH);

			await lmdb_create_txn_envs(CREATE_TABLE_OBJ);
		});

		afterEach(async () => {
			let env1 = await environment_utility.openEnvironment(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.table, true);
			await env1.close();

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('deleting 19000 out of 20k txns', async () => {
			let m_times = await createTransactions(20000);
			let env = await environment_utility.openEnvironment(BASE_TRANSACTIONS_PATH, 'test', true);
			let delete_before_obj = new DeleteBeforeObject('dev', 'test', m_times[19000]);
			let results = await delete_txn_logs_before(delete_before_obj);
			let expected_results = new DeleteTransactionsBeforeResults(m_times[0], m_times[18999], 19000);
			assert.deepStrictEqual(results, expected_results);

			let iterate_results = search_util.iterateDBI(env, 'timestamp');
			let x = 19000;
			Object.keys(iterate_results).forEach((result) => {
				assert.deepStrictEqual(result, m_times[x++].toString());
			});

			iterate_results = search_util.iterateDBI(env, 'user_name');
			x = 19000;
			Object.values(iterate_results)[0].forEach((result) => {
				assert.deepStrictEqual(result, m_times[x++]);
			});

			iterate_results = search_util.iterateDBI(env, 'hash_value');
			x = 19000;
			Object.values(iterate_results)[0].forEach((result) => {
				assert.deepStrictEqual(result, m_times[x++]);
			});
		}).timeout(5000);
	});
});

async function createTransactions(count) {
	let insert_obj = new InsertObject('dev', 'test', 'id', INSERT_RECORDS);
	insert_obj.hdb_user = HDB_USER;

	let m_times = [];
	let promises = [];
	for (let x = 0; x < count; x++) {
		let insert_response = new InsertRecordsResponseObject(INSERT_HASHES, []);
		m_times[x] = common.getMicroTime();
		insert_response.txn_time = m_times[x];
		promises.push(lmdb_write_txn(insert_obj, insert_response));
	}
	await Promise.all(promises);
	return m_times;
}
