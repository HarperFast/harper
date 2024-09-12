'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
const path = require('path');

const SYSTEM_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockLMDBPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, SYSTEM_FOLDER_NAME);
const TRANSACTIONS_NAME = 'transactions';
const BASE_TXN_PATH = path.join(BASE_PATH, TRANSACTIONS_NAME);
const TXN_SCHEMA_PATH = path.join(BASE_TXN_PATH, 'dev');

const rewire = require('rewire');
const lmdb_create_records = rewire('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateRecords');
const lmdb_delete_records = rewire('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbDeleteRecords');
const lmdb_create_schema = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const search_utility = require('../../../../../utility/lmdb/searchUtility');
const lmdb_common = require('../../../../../utility/lmdb/commonUtility');
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');
const verify_txn = require('../_verifyTxns');
const env_manager = require('../../../../../utility/environment/environmentManager');
const hdb_terms = require('../../../../../utility/hdbTerms');

const LMDBInsertTransactionObject = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/LMDBInsertTransactionObject');
const LMDBDeleteTransactionObject = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/LMDBDeleteTransactionObject');

let insert_date = new Date();
insert_date.setMinutes(insert_date.getMinutes() - 10);
const INSERT_TIMESTAMP = insert_date.getTime();

const TIMESTAMP = Date.now();
const HASH_ATTRIBUTE_NAME = 'id';

const INSERT_OBJECT_TEST = {
	operation: 'insert',
	schema: 'dev',
	table: 'dog',
	records: [
		{
			name: 'Harper',
			breed: 'Mutt',
			id: 8,
			age: 5,
		},
		{
			name: 'Penny',
			breed: 'Mutt',
			id: 9,
			age: 5,
			height: 145,
		},
		{
			name: 'David',
			breed: 'Mutt',
			id: 12,
		},
		{
			name: 'Rob',
			breed: 'Mutt',
			id: 10,
			age: 5,
			height: 145,
		},
	],
};

const INSERT_HASHES = [8, 9, 12, 10];

const ALL_FETCH_ATTRIBUTES = ['__createdtime__', '__updatedtime__', 'age', 'breed', 'height', 'id', 'name'];

const SCHEMA_TABLE_TEST = {
	id: 'c43762be-4943-4d10-81fb-1b857ed6cf3a',
	name: 'dog',
	hash_attribute: HASH_ATTRIBUTE_NAME,
	schema: 'dev',
	attributes: [],
};

const CREATE_SCHEMA_DEV = {
	operation: 'create_schema',
	schema: 'dev',
};

const CREATE_TABLE_OBJ_TEST_A = {
	operation: 'create_table',
	schema: 'dev',
	table: 'dog',
	hash_attribute: 'id',
};

const TABLE_SYSTEM_DATA_TEST_A = {
	name: CREATE_TABLE_OBJ_TEST_A.table,
	schema: CREATE_TABLE_OBJ_TEST_A.schema,
	id: '82j3r4',
	hash_attribute: CREATE_TABLE_OBJ_TEST_A.hash_attribute,
	residence: '*',
};

const sandbox = sinon.createSandbox();

describe('Test lmdbDeleteRecords module', () => {
	let date_stub;

	before(() => {
		date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_AUDITLOG, true);
	});

	after(() => {
		date_stub.restore();
		global.lmdb_map = undefined;
	});

	describe('Test lmdbDeleteRecords function', () => {
		let m_time;
		let insert_m_time;
		let m_time_stub;
		let expected_timestamp_txn;
		let expected_hashes_txn;

		let hdb_schema_env;
		let hdb_table_env;
		let hdb_attribute_env;
		beforeEach(async () => {
			date_stub.restore();
			date_stub = sandbox.stub(Date, 'now').returns(INSERT_TIMESTAMP);
			global.hdb_schema = {
				[SCHEMA_TABLE_TEST.schema]: {
					[SCHEMA_TABLE_TEST.name]: {
						attributes: SCHEMA_TABLE_TEST.attributes,
						hash_attribute: SCHEMA_TABLE_TEST.hash_attribute,
						residence: SCHEMA_TABLE_TEST.residence,
						schema: SCHEMA_TABLE_TEST.schema,
						name: SCHEMA_TABLE_TEST.name,
					},
				},
				system: systemSchema,
			};

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
			await fs.mkdirp(SYSTEM_SCHEMA_PATH);

			hdb_schema_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_schema.name);
			environment_utility.createDBI(hdb_schema_env, systemSchema.hdb_schema.hash_attribute, false, true);

			hdb_table_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_table.name);
			environment_utility.createDBI(hdb_table_env, systemSchema.hdb_table.hash_attribute, false, true);

			hdb_attribute_env = await environment_utility.createEnvironment(
				SYSTEM_SCHEMA_PATH,
				systemSchema.hdb_attribute.name
			);
			environment_utility.createDBI(hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, false, true);

			await lmdb_create_schema(CREATE_SCHEMA_DEV);

			await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A);

			m_time = INSERT_TIMESTAMP;
			insert_m_time = m_time;
			m_time_stub = sandbox.stub(lmdb_common, 'getNextMonotonicTime').returns(m_time);

			let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
			await lmdb_create_records(insert_obj);

			let insert_txn_obj = new LMDBInsertTransactionObject(insert_obj.records, undefined, m_time, INSERT_HASHES);
			expected_timestamp_txn = test_utils.assignObjecttoNullObject({
				[m_time]: [insert_txn_obj],
			});

			expected_hashes_txn = Object.create(null);
			insert_obj.records.forEach((record) => {
				expected_hashes_txn[record[HASH_ATTRIBUTE_NAME]] = [m_time];
			});

			date_stub.restore();
			date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);

			m_time_stub.restore();
			m_time = lmdb_common.getNextMonotonicTime();
			m_time_stub = sandbox.stub(lmdb_common, 'getNextMonotonicTime').returns(m_time);
		});

		afterEach(async () => {
			let env2 = await environment_utility.openEnvironment(
				path.join(BASE_SCHEMA_PATH, CREATE_TABLE_OBJ_TEST_A.schema),
				CREATE_TABLE_OBJ_TEST_A.table
			);
			await env2.close();

			let txn_env1 = await environment_utility.openEnvironment(
				path.join(BASE_TXN_PATH, CREATE_TABLE_OBJ_TEST_A.schema),
				CREATE_TABLE_OBJ_TEST_A.table,
				true
			);
			await txn_env1.close();

			await hdb_schema_env.close();
			await hdb_table_env.close();
			await hdb_attribute_env.close();

			m_time_stub.restore();

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
			delete global.hdb_schema;
		});

		it('Test deleting 1 row', async () => {
			let delete_obj = {
				operation: 'delete',
				table: 'dog',
				schema: 'dev',
				hash_values: [8],
			};
			let expected_result = {
				message: '1 of 1 record successfully deleted',
				deleted_hashes: [8],
				skipped_hashes: [],
				txn_time: m_time,
			};

			//verify inserted txn
			let copy_expected_timestamp_txn = Object.create(null);
			for (let [key, value] of Object.entries(expected_timestamp_txn)) {
				copy_expected_timestamp_txn[key] = [{ ...value[0] }];
			}
			let copy_expected_hashes_txn = test_utils.assignObjecttoNullObject(test_utils.deepClone(expected_hashes_txn));

			await verify_txn(
				TXN_SCHEMA_PATH,
				INSERT_OBJECT_TEST.table,
				copy_expected_timestamp_txn,
				copy_expected_hashes_txn
			);

			let results = await test_utils.assertErrorAsync(lmdb_delete_records, [delete_obj], undefined);
			assert.deepStrictEqual(results, expected_result);

			let dog_env = await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[path.join(BASE_SCHEMA_PATH, INSERT_OBJECT_TEST.schema), INSERT_OBJECT_TEST.table],
				undefined
			);
			let record = test_utils.assertErrorSync(
				search_utility.searchByHash,
				[dog_env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, 8],
				undefined
			);
			assert.deepStrictEqual(record, null);
			//iterate all dbis and make sure all references to hash 8 are gone
			ALL_FETCH_ATTRIBUTES.forEach((attribute) => {
				if (attribute !== HASH_ATTRIBUTE_NAME) {
					let attr_results = test_utils.assertErrorSync(search_utility.iterateDBI, [dog_env, 'height'], undefined);
					Object.keys(attr_results).forEach((result) => {
						assert(result !== 8);
					});
				}
			});

			//verify txns with delete
			let orig_rec = {
				name: 'Harper',
				breed: 'Mutt',
				id: 8,
				age: 5,
				__updatedtime__: INSERT_TIMESTAMP,
				__createdtime__: INSERT_TIMESTAMP,
			};

			let delete_txn = { ...new LMDBDeleteTransactionObject([8], [orig_rec], undefined, m_time) };
			copy_expected_timestamp_txn[m_time] = [delete_txn];

			copy_expected_hashes_txn[8].push(m_time);
			await verify_txn(
				TXN_SCHEMA_PATH,
				INSERT_OBJECT_TEST.table,
				copy_expected_timestamp_txn,
				copy_expected_hashes_txn
			);
		});

		it('Test deleting two values from table, one that does not exist', async () => {
			let delete_obj = {
				operation: 'delete',
				table: 'dog',
				schema: 'dev',
				hash_values: [8, 9999],
			};
			let expected_result = {
				message: '1 of 2 records successfully deleted',
				deleted_hashes: [8],
				skipped_hashes: [9999],
				txn_time: m_time,
			};

			//verify inserted txn
			let copy_expected_timestamp_txn = Object.create(null);
			for (let [key, value] of Object.entries(expected_timestamp_txn)) {
				copy_expected_timestamp_txn[key] = [{ ...value[0] }];
			}
			let copy_expected_hashes_txn = test_utils.assignObjecttoNullObject(test_utils.deepClone(expected_hashes_txn));
			await verify_txn(
				TXN_SCHEMA_PATH,
				INSERT_OBJECT_TEST.table,
				copy_expected_timestamp_txn,
				copy_expected_hashes_txn
			);

			let results = await test_utils.assertErrorAsync(lmdb_delete_records, [delete_obj], undefined);
			assert.deepStrictEqual(results, expected_result);

			let dog_env = await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[path.join(BASE_SCHEMA_PATH, INSERT_OBJECT_TEST.schema), INSERT_OBJECT_TEST.table],
				undefined
			);
			let record = test_utils.assertErrorSync(
				search_utility.searchByHash,
				[dog_env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, 8],
				undefined
			);
			assert.deepStrictEqual(record, null);
			//iterate all dbis and make sure all references to hash 8 are gone
			ALL_FETCH_ATTRIBUTES.forEach((attribute) => {
				if (attribute !== HASH_ATTRIBUTE_NAME) {
					let attr_results = test_utils.assertErrorSync(search_utility.iterateDBI, [dog_env, 'height'], undefined);
					Object.keys(attr_results).forEach((result) => {
						assert(result !== 8);
					});
				}
			});

			//verify txns with delete
			let orig_rec = {
				name: 'Harper',
				breed: 'Mutt',
				id: 8,
				age: 5,
				__updatedtime__: INSERT_TIMESTAMP,
				__createdtime__: INSERT_TIMESTAMP,
			};

			let delete_txn = { ...new LMDBDeleteTransactionObject([8], [orig_rec], undefined, m_time) };
			copy_expected_timestamp_txn[m_time] = [delete_txn];

			copy_expected_hashes_txn[8].push(m_time);
			await verify_txn(
				TXN_SCHEMA_PATH,
				INSERT_OBJECT_TEST.table,
				copy_expected_timestamp_txn,
				copy_expected_hashes_txn
			);
		});

		it('Test deleting two values from table that do not exist', async () => {
			let delete_obj = {
				operation: 'delete',
				table: 'dog',
				schema: 'dev',
				hash_values: [8888, 9999],
			};
			let expected_result = {
				message: '0 of 2 records successfully deleted',
				deleted_hashes: [],
				skipped_hashes: [8888, 9999],
				txn_time: m_time,
			};

			//verify inserted txn
			let copy_expected_timestamp_txn = Object.create(null);
			for (let [key, value] of Object.entries(expected_timestamp_txn)) {
				copy_expected_timestamp_txn[key] = [{ ...value[0] }];
			}
			let copy_expected_hashes_txn = test_utils.assignObjecttoNullObject(test_utils.deepClone(expected_hashes_txn));
			await verify_txn(
				TXN_SCHEMA_PATH,
				INSERT_OBJECT_TEST.table,
				copy_expected_timestamp_txn,
				copy_expected_hashes_txn
			);

			let results = await test_utils.assertErrorAsync(lmdb_delete_records, [delete_obj], undefined);
			assert.deepStrictEqual(results, expected_result);

			//verify inserted txn
			await verify_txn(
				TXN_SCHEMA_PATH,
				INSERT_OBJECT_TEST.table,
				copy_expected_timestamp_txn,
				copy_expected_hashes_txn
			);
		});

		it('Test deleting multiple values from table', async () => {
			let delete_obj = {
				operation: 'delete',
				table: 'dog',
				schema: 'dev',
				hash_values: [10, 12],
			};
			let expected_result = {
				message: '2 of 2 records successfully deleted',
				deleted_hashes: [10, 12],
				skipped_hashes: [],
				txn_time: m_time,
			};

			//verify inserted txn
			let copy_expected_timestamp_txn = Object.create(null);
			for (let [key, value] of Object.entries(expected_timestamp_txn)) {
				copy_expected_timestamp_txn[key] = [{ ...value[0] }];
			}
			let copy_expected_hashes_txn = test_utils.assignObjecttoNullObject(test_utils.deepClone(expected_hashes_txn));
			await verify_txn(
				TXN_SCHEMA_PATH,
				INSERT_OBJECT_TEST.table,
				copy_expected_timestamp_txn,
				copy_expected_hashes_txn
			);

			let results = await test_utils.assertErrorAsync(lmdb_delete_records, [delete_obj], undefined);
			assert.deepStrictEqual(results, expected_result);

			let dog_env = await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[path.join(BASE_SCHEMA_PATH, INSERT_OBJECT_TEST.schema), INSERT_OBJECT_TEST.table],
				undefined
			);
			let record = test_utils.assertErrorSync(
				search_utility.batchSearchByHash,
				[dog_env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, [12, 10]],
				undefined
			);
			assert.deepStrictEqual(record, []);
			//iterate all dbis and make sure all references to hash 8 are gone
			ALL_FETCH_ATTRIBUTES.forEach((attribute) => {
				if (attribute !== HASH_ATTRIBUTE_NAME) {
					let attr_results = test_utils.assertErrorSync(search_utility.iterateDBI, [dog_env, 'height'], undefined);
					Object.keys(attr_results).forEach((result) => {
						assert(delete_obj.hash_values.indexOf(result[1]) < 0);
					});
				}
			});

			//verify txns with delete
			let orig_recs = [
				{
					name: 'Rob',
					breed: 'Mutt',
					id: 10,
					age: 5,
					height: 145,
					__updatedtime__: INSERT_TIMESTAMP,
					__createdtime__: INSERT_TIMESTAMP,
				},
				{
					name: 'David',
					breed: 'Mutt',
					id: 12,
					__updatedtime__: INSERT_TIMESTAMP,
					__createdtime__: INSERT_TIMESTAMP,
				},
			];

			let delete_txn = { ...new LMDBDeleteTransactionObject([10, 12], orig_recs, undefined, m_time) };
			copy_expected_timestamp_txn[m_time] = [delete_txn];

			copy_expected_hashes_txn[10].push(m_time);
			copy_expected_hashes_txn[12].push(m_time);
			await verify_txn(
				TXN_SCHEMA_PATH,
				INSERT_OBJECT_TEST.table,
				copy_expected_timestamp_txn,
				copy_expected_hashes_txn
			);
		});

		it('Test that error from  deleteRows is caught and thrown', async () => {
			let delete_obj = {
				operation: 'delete',
				table: 'dog',
				schema: 'dev',
				hash_values: 12,
			};

			await test_utils.assertErrorAsync(lmdb_delete_records, [delete_obj], new Error('hash_values must be an array'));
		});

		it('Test passing no hash_values or records', async () => {
			let delete_obj = {
				operation: 'delete',
				table: 'dog',
				schema: 'dev',
			};

			let expected_result = {
				message: '0 of 0 records successfully deleted',
				deleted_hashes: [],
				skipped_hashes: [],
				txn_time: undefined,
			};

			let results = await test_utils.assertErrorAsync(lmdb_delete_records, [delete_obj], undefined);

			assert.deepStrictEqual(results, expected_result);
		});

		it('Test passing records instead of hash_values', async () => {
			let delete_obj = {
				operation: 'delete',
				table: 'dog',
				schema: 'dev',
				records: [
					{
						id: 10,
					},
				],
			};

			let expected_result = {
				message: '1 of 1 record successfully deleted',
				deleted_hashes: [10],
				skipped_hashes: [],
				txn_time: m_time,
			};

			//verify inserted txn
			let copy_expected_timestamp_txn = Object.create(null);
			for (let [key, value] of Object.entries(expected_timestamp_txn)) {
				copy_expected_timestamp_txn[key] = [{ ...value[0] }];
			}
			let copy_expected_hashes_txn = test_utils.assignObjecttoNullObject(test_utils.deepClone(expected_hashes_txn));
			await verify_txn(
				TXN_SCHEMA_PATH,
				INSERT_OBJECT_TEST.table,
				copy_expected_timestamp_txn,
				copy_expected_hashes_txn
			);

			let results = await test_utils.assertErrorAsync(lmdb_delete_records, [delete_obj], undefined);

			assert.deepStrictEqual(results, expected_result);

			//verify txns with delete
			let orig_recs = [
				{
					name: 'Rob',
					breed: 'Mutt',
					id: 10,
					age: 5,
					height: 145,
					__updatedtime__: INSERT_TIMESTAMP,
					__createdtime__: INSERT_TIMESTAMP,
				},
			];

			let delete_txn = { ...new LMDBDeleteTransactionObject([10], orig_recs, undefined, m_time) };
			copy_expected_timestamp_txn[m_time] = [delete_txn];

			copy_expected_hashes_txn[10].push(m_time);
			await verify_txn(
				TXN_SCHEMA_PATH,
				INSERT_OBJECT_TEST.table,
				copy_expected_timestamp_txn,
				copy_expected_hashes_txn
			);
		});

		it('Test passing records instead of hash_values where record hash no hash value', async () => {
			let delete_obj = {
				operation: 'delete',
				table: 'dog',
				schema: 'dev',
				records: [
					{
						name: 'Riley',
					},
				],
			};

			let expected_result = {
				message: '0 of 0 records successfully deleted',
				deleted_hashes: [],
				skipped_hashes: [],
				txn_time: undefined,
			};

			let results = await test_utils.assertErrorAsync(lmdb_delete_records, [delete_obj], undefined);

			assert.deepStrictEqual(results, expected_result);
		});

		it('Test that error thrown if hash not present', async () => {
			global.hdb_schema['dev']['dog']['hash_attribute'] = null;

			let delete_obj = {
				operation: 'delete',
				table: 'dog',
				schema: 'dev',
				hash_values: [12],
			};

			await test_utils.assertErrorAsync(
				lmdb_delete_records,
				[delete_obj],
				new Error(`could not retrieve hash attribute for schema:${delete_obj.schema} and table ${delete_obj.table}`)
			);
		});
	});
});
