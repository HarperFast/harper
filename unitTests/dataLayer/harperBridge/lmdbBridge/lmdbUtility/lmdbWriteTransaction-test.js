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
const lmdb_write_txn = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/lmdbWriteTransaction');
const rw_lmdb_write_txn = rewire('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/lmdbWriteTransaction');
const search_util = require('../../../../../utility/lmdb/searchUtility');

const env_mngr = require('../../../../../utility/environment/environmentManager');

const create_transaction_object_func = rw_lmdb_write_txn.__get__('createTransactionObject');

const CreateTableObject = require('../../../../../dataLayer/CreateTableObject');

const assert = require('assert');
const fs = require('fs-extra');
const common = require('../../../../../utility/lmdb/commonUtility');

const InsertObject = require('../../../../../dataLayer/InsertObject');
const UpdateObject = require('../../../../../dataLayer/UpdateObject');
const UpsertObject = require('../../../../../dataLayer/UpsertObject');
const DeleteObject = require('../../../../../dataLayer/DeleteObject');

const InsertRecordsResponseObject = require('../../../../../utility/lmdb/InsertRecordsResponseObject');
const UpdateRecordsResponseObject = require('../../../../../utility/lmdb/UpdateRecordsResponseObject');
const UpsertRecordsResponseObject = require('../../../../../utility/lmdb/UpsertRecordsResponseObject');
const DeleteRecordsResponseObject = require('../../../../../utility/lmdb/DeleteRecordsResponseObject');

const LMDBInsertTransactionObject = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/LMDBInsertTransactionObject');
const LMDBUpdateTransactionObject = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/LMDBUpdateTransactionObject');
const LMDBUpsertTransactionObject = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/LMDBUpsertTransactionObject');
const LMDBDeleteTransactionObject = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/LMDBDeleteTransactionObject');

const orig_clustering_setting = env_mngr.get('CLUSTERING');
const orig_disable_txn_setting = env_mngr.get('DISABLE_TRANSACTION_LOG');

const CREATE_TABLE_OBJ = new CreateTableObject('dev', 'test', 'id');

const INSERT_RECORDS = [
	{ id: 1, name: 'Penny' },
	{ id: 2, name: 'Kato', age: 6 },
	{ id: 3, name: 'Riley', age: 7 },
	{ id: 'blerrrrr', name: 'Rosco' },
];

const UPDATE_RECORDS = [
	{ id: 1, name: 'Penny B' },
	{ id: 2, name: 'Kato B', age: 6 },
	{ id: 3, name: 'Riley S', age: 7 },
	{ id: 'blerrrrr', name: 'Rosco ?' },
];

const UPSERT_RECORDS = [
	{ id: 1, name: 'Penny B', age: 10 },
	{ id: 2, name: 'Kato B', age: 7 },
	{ id: 3, name: 'Riley S', age: 8 },
	{ id: 'blerrrrr', name: 'Rosco ?' },
];

let INSERT_HASHES = [1, 2, 3, 'blerrrrr'];
const HDB_USER = {
	username: 'kyle',
};

describe('test lmdbWriteTransaction module', () => {
	before(async () => {
		await fs.remove(BASE_PATH);
	});

	after(() => {});

	describe('test createTransactionObject function', () => {
		before(async () => {
			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		after(async () => {
			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('test for insert operation no user on operation', async () => {
			let insert_obj = new InsertObject('dev', 'test', 'id', INSERT_RECORDS);
			let insert_response = new InsertRecordsResponseObject(INSERT_HASHES, [], common.getNextMonotonicTime());

			let insert_txn_obj = new LMDBInsertTransactionObject(
				INSERT_RECORDS,
				undefined,
				insert_response.txn_time,
				INSERT_HASHES
			);

			let error = undefined;
			let response = undefined;
			try {
				response = create_transaction_object_func(insert_obj, insert_response);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);

			assert.deepStrictEqual(response, insert_txn_obj);
		});
		it('test for insert operation with user on operation', async () => {
			let insert_obj = new InsertObject('dev', 'test', 'id', INSERT_RECORDS);
			insert_obj.hdb_user = HDB_USER;
			let insert_response = new InsertRecordsResponseObject(INSERT_HASHES, [], common.getNextMonotonicTime());

			let insert_txn_obj = new LMDBInsertTransactionObject(
				INSERT_RECORDS,
				HDB_USER.username,
				insert_response.txn_time,
				INSERT_HASHES
			);

			let error = undefined;
			let response = undefined;
			try {
				response = create_transaction_object_func(insert_obj, insert_response);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);

			assert.deepStrictEqual(response, insert_txn_obj);
		});

		it('test for update operation', async () => {
			let update_obj = new UpdateObject('dev', 'test', UPDATE_RECORDS);
			update_obj.hdb_user = HDB_USER;
			let update_response = new UpdateRecordsResponseObject(
				INSERT_HASHES,
				[],
				common.getNextMonotonicTime(),
				INSERT_RECORDS
			);

			let update_txn_obj = new LMDBUpdateTransactionObject(
				UPDATE_RECORDS,
				INSERT_RECORDS,
				HDB_USER.username,
				update_response.txn_time,
				INSERT_HASHES
			);

			let error = undefined;
			let response = undefined;
			try {
				response = create_transaction_object_func(update_obj, update_response);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);

			assert.deepStrictEqual(response, update_txn_obj);
		});

		it('test for upsert operation', async () => {
			let upsert_obj = new UpsertObject('dev', 'test', UPSERT_RECORDS);
			upsert_obj.hdb_user = HDB_USER;
			let upsert_response = new UpsertRecordsResponseObject(
				INSERT_HASHES,
				common.getNextMonotonicTime(),
				INSERT_RECORDS
			);

			let upsert_txn_obj = new LMDBUpsertTransactionObject(
				UPSERT_RECORDS,
				INSERT_RECORDS,
				HDB_USER.username,
				upsert_response.txn_time,
				INSERT_HASHES
			);

			let error = undefined;
			let response = undefined;
			try {
				response = create_transaction_object_func(upsert_obj, upsert_response);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);

			assert.deepStrictEqual(response, upsert_txn_obj);
		});

		it('test for delete operation', async () => {
			let delete_obj = new DeleteObject('dev', 'test', INSERT_HASHES);
			delete_obj.hdb_user = HDB_USER;
			let delete_response = new DeleteRecordsResponseObject(
				INSERT_HASHES,
				[],
				common.getNextMonotonicTime(),
				UPDATE_RECORDS
			);

			let delete_txn_obj = new LMDBDeleteTransactionObject(
				INSERT_HASHES,
				UPDATE_RECORDS,
				HDB_USER.username,
				delete_response.txn_time
			);

			let error = undefined;
			let response = undefined;
			try {
				response = create_transaction_object_func(delete_obj, delete_response);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);

			assert.deepStrictEqual(response, delete_txn_obj);
		});

		it('test for unknown operation', async () => {
			let delete_obj = { operation: 'other' };
			delete_obj.hdb_user = HDB_USER;
			let delete_response = new DeleteRecordsResponseObject(
				INSERT_HASHES,
				[],
				common.getNextMonotonicTime(),
				UPDATE_RECORDS
			);

			let error = undefined;
			let response = undefined;
			try {
				response = create_transaction_object_func(delete_obj, delete_response);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);

			assert.deepStrictEqual(response, undefined);
		});
	});

	describe('test writeTransaction function', () => {
		let env;
		beforeEach(async () => {
			await fs.mkdirp(BASE_PATH);
			global.lmdb_map = undefined;
			env = await lmdb_create_txn_envs(CREATE_TABLE_OBJ);
			env_mngr.setProperty('logging_auditlog', true);
		});

		afterEach(async () => {
			await env.close();
			try {
				await fs.remove(BASE_PATH);
			} catch (error) {}
			global.lmdb_map = undefined;
		});

		it('test writing insert no user on operation', async () => {
			let insert_obj = new InsertObject('dev', 'test', 'id', INSERT_RECORDS);
			let insert_response = new InsertRecordsResponseObject(INSERT_HASHES, [], common.getNextMonotonicTime());

			//call the write txn function
			let error = undefined;
			try {
				await lmdb_write_txn(insert_obj, insert_response);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);

			//test expected entries exist
			let transaction_path = path.join(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.schema);
			let txn_env = undefined;
			try {
				txn_env = await environment_utility.openEnvironment(transaction_path, CREATE_TABLE_OBJ.table, true);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);
			assert.notStrictEqual(txn_env, undefined);

			let insert_txn_obj = {
				...new LMDBInsertTransactionObject(INSERT_RECORDS, undefined, insert_response.txn_time, INSERT_HASHES),
			};
			let expected_timestamp_results = test_utils.assignObjecttoNullObject({
				[insert_response.txn_time]: [insert_txn_obj],
			});

			let results = search_util.iterateDBI(txn_env, 'timestamp');
			assert.deepStrictEqual(results, expected_timestamp_results);

			let expected_hash_value_results = Object.create(null);
			INSERT_HASHES.forEach((hash) => {
				expected_hash_value_results[hash] = [insert_response.txn_time];
			});
			results = search_util.iterateDBI(txn_env, 'hash_value');
			assert.deepStrictEqual(results, expected_hash_value_results);

			results = search_util.iterateDBI(txn_env, 'user_name');
			assert.deepStrictEqual(results, Object.create(null));
		});

		it('test writing insert with transaction log disabled', async () => {
			env_mngr.setProperty('logging_auditlog', false);

			let insert_obj = new InsertObject('dev', 'test', 'id', INSERT_RECORDS);
			let insert_response = new InsertRecordsResponseObject(INSERT_HASHES, [], common.getNextMonotonicTime());

			//call the write txn function
			let error = undefined;
			try {
				await rw_lmdb_write_txn(insert_obj, insert_response);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);

			//test expected entries exist
			let transaction_path = path.join(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.schema);
			let txn_env = undefined;
			try {
				txn_env = await environment_utility.openEnvironment(transaction_path, CREATE_TABLE_OBJ.table, true);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);
			assert.notStrictEqual(txn_env, undefined);

			let results = search_util.iterateDBI(txn_env, 'timestamp');
			assert.deepStrictEqual(results, Object.create(null));

			results = search_util.iterateDBI(txn_env, 'hash_value');
			assert.deepStrictEqual(results, Object.create(null));

			results = search_util.iterateDBI(txn_env, 'user_name');
			assert.deepStrictEqual(results, Object.create(null));
		});

		it('test writing insert with user on operation', async () => {
			let insert_obj = new InsertObject('dev', 'test', 'id', INSERT_RECORDS);
			insert_obj.hdb_user = HDB_USER;
			let insert_response = new InsertRecordsResponseObject(INSERT_HASHES, [], common.getNextMonotonicTime());

			//call the write txn function
			let error = undefined;
			try {
				await lmdb_write_txn(insert_obj, insert_response);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);

			//test expected entries exist
			let transaction_path = path.join(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.schema);
			let txn_env = undefined;
			try {
				txn_env = await environment_utility.openEnvironment(transaction_path, CREATE_TABLE_OBJ.table, true);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);
			assert.notStrictEqual(txn_env, undefined);

			let insert_txn_obj = {
				...new LMDBInsertTransactionObject(INSERT_RECORDS, HDB_USER.username, insert_response.txn_time, INSERT_HASHES),
			};
			let expected_timestamp_results = test_utils.assignObjecttoNullObject({
				[insert_response.txn_time]: [insert_txn_obj],
			});

			let results = search_util.iterateDBI(txn_env, 'timestamp');
			assert.deepStrictEqual(results, expected_timestamp_results);

			let expected_hash_value_results = Object.create(null);
			INSERT_HASHES.forEach((hash) => {
				expected_hash_value_results[hash] = [insert_response.txn_time];
			});
			results = search_util.iterateDBI(txn_env, 'hash_value');
			assert.deepStrictEqual(results, expected_hash_value_results);

			let expected_username_results = Object.create(null);
			expected_username_results[HDB_USER.username] = [insert_response.txn_time];

			results = search_util.iterateDBI(txn_env, 'user_name');
			assert.deepStrictEqual(results, expected_username_results);
		});

		it('test writing update with user on operation', async () => {
			let update_obj = new UpdateObject('dev', 'test', UPDATE_RECORDS);
			update_obj.hdb_user = HDB_USER;
			let update_response = new UpdateRecordsResponseObject(
				INSERT_HASHES,
				[],
				common.getNextMonotonicTime(),
				INSERT_RECORDS
			);

			//call the write txn function
			let error = undefined;
			try {
				await lmdb_write_txn(update_obj, update_response);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);

			//test expected entries exist
			let transaction_path = path.join(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.schema);
			let txn_env = undefined;
			try {
				txn_env = await environment_utility.openEnvironment(transaction_path, CREATE_TABLE_OBJ.table, true);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);
			assert.notStrictEqual(txn_env, undefined);

			let update_txn_obj = {
				...new LMDBUpdateTransactionObject(
					UPDATE_RECORDS,
					INSERT_RECORDS,
					HDB_USER.username,
					update_response.txn_time,
					INSERT_HASHES
				),
			};
			let expected_timestamp_results = test_utils.assignObjecttoNullObject({
				[update_response.txn_time]: [update_txn_obj],
			});

			let results = search_util.iterateDBI(txn_env, 'timestamp');
			assert.deepStrictEqual(results, expected_timestamp_results);

			let expected_hash_value_results = Object.create(null);
			INSERT_HASHES.forEach((hash) => {
				expected_hash_value_results[hash] = [update_response.txn_time];
			});
			results = search_util.iterateDBI(txn_env, 'hash_value');
			assert.deepStrictEqual(results, expected_hash_value_results);

			let expected_username_results = Object.create(null);
			expected_username_results[HDB_USER.username] = [update_response.txn_time];

			results = search_util.iterateDBI(txn_env, 'user_name');
			assert.deepStrictEqual(results, expected_username_results);
		});

		it('test writing upsert with user on operation', async () => {
			let upsert_obj = new UpsertObject('dev', 'test', UPSERT_RECORDS);
			upsert_obj.hdb_user = HDB_USER;
			let upsert_response = new UpsertRecordsResponseObject(
				INSERT_HASHES,
				common.getNextMonotonicTime(),
				UPDATE_RECORDS
			);

			//call the write txn function
			let error = undefined;
			try {
				await lmdb_write_txn(upsert_obj, upsert_response);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);

			//test expected entries exist
			let transaction_path = path.join(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.schema);
			let txn_env = undefined;
			try {
				txn_env = await environment_utility.openEnvironment(transaction_path, CREATE_TABLE_OBJ.table, true);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);
			assert.notStrictEqual(txn_env, undefined);

			let upsert_txn_obj = {
				...new LMDBUpsertTransactionObject(
					UPSERT_RECORDS,
					UPDATE_RECORDS,
					HDB_USER.username,
					upsert_response.txn_time,
					INSERT_HASHES
				),
			};
			let expected_timestamp_results = test_utils.assignObjecttoNullObject({
				[upsert_response.txn_time]: [upsert_txn_obj],
			});

			let results = search_util.iterateDBI(txn_env, 'timestamp');
			assert.deepStrictEqual(results, expected_timestamp_results);

			let expected_hash_value_results = Object.create(null);
			INSERT_HASHES.forEach((hash) => {
				expected_hash_value_results[hash] = [upsert_response.txn_time];
			});
			results = search_util.iterateDBI(txn_env, 'hash_value');
			assert.deepStrictEqual(results, expected_hash_value_results);

			let expected_username_results = Object.create(null);
			expected_username_results[HDB_USER.username] = [upsert_response.txn_time];

			results = search_util.iterateDBI(txn_env, 'user_name');
			assert.deepStrictEqual(results, expected_username_results);
		});

		it('test writing delete with user on operation', async () => {
			let delete_obj = new DeleteObject('dev', 'test', UPDATE_RECORDS);
			delete_obj.hdb_user = HDB_USER;
			let delete_response = new DeleteRecordsResponseObject(
				INSERT_HASHES,
				[],
				common.getNextMonotonicTime(),
				UPDATE_RECORDS
			);

			//call the write txn function
			let error = undefined;
			try {
				await lmdb_write_txn(delete_obj, delete_response);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);

			//test expected entries exist
			let transaction_path = path.join(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.schema);
			let txn_env = undefined;
			try {
				txn_env = await environment_utility.openEnvironment(transaction_path, CREATE_TABLE_OBJ.table, true);
			} catch (e) {
				error = e;
			}
			assert.deepStrictEqual(error, undefined);
			assert.notStrictEqual(txn_env, undefined);

			let delete_txn_obj = {
				...new LMDBDeleteTransactionObject(INSERT_HASHES, UPDATE_RECORDS, HDB_USER.username, delete_response.txn_time),
			};
			let expected_timestamp_results = test_utils.assignObjecttoNullObject({
				[delete_response.txn_time]: [delete_txn_obj],
			});

			let results = search_util.iterateDBI(txn_env, 'timestamp');
			assert.deepStrictEqual(results, expected_timestamp_results);

			let expected_hash_value_results = Object.create(null);
			INSERT_HASHES.forEach((hash) => {
				expected_hash_value_results[hash] = [delete_response.txn_time];
			});
			results = search_util.iterateDBI(txn_env, 'hash_value');
			assert.deepStrictEqual(results, expected_hash_value_results);

			let expected_username_results = Object.create(null);
			expected_username_results[HDB_USER.username] = [delete_response.txn_time];

			results = search_util.iterateDBI(txn_env, 'user_name');
			assert.deepStrictEqual(results, expected_username_results);
		});
	});
});
