'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
const path = require('path');

const SYSTEM_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockLMDBPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const BASE_TXN_PATH = path.join(BASE_PATH, 'transactions');
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, SYSTEM_FOLDER_NAME);
const DEV_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, 'dev');

let test_data = require('../../../../testData');

const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const SearchObject = require('../../../../../data_layer/SearchObject');
const delete_records_before = rewire(
	'../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbDeleteRecordsBefore'
);
const search_by_value = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbSearchByValue');
const lmdb_create_schema = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
const lmdb_create_records = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateRecords');
const lmdb_read_txn_log = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbReadTransactionLog');
const hdb_terms = require('../../../../../utility/hdbTerms');
const assert = require('assert');
const fs = require('fs-extra');
const systemSchema = require('../../../../../json/systemSchema');
const ReadTransactionLogObject = require('../../../../../data_layer/ReadTransactionLogObject');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

const CREATE_SCHEMA_DEV = {
	operation: 'create_schema',
	schema: 'dev',
};

const CREATE_TABLE_OBJ_TEST_A = {
	operation: 'create_table',
	schema: 'dev',
	table: 'test',
	hash_attribute: 'id',
};

const TABLE_SYSTEM_DATA_TEST_A = {
	name: CREATE_TABLE_OBJ_TEST_A.table,
	schema: CREATE_TABLE_OBJ_TEST_A.schema,
	id: '82j3r4',
	hash_attribute: CREATE_TABLE_OBJ_TEST_A.hash_attribute,
	residence: '*',
};

const CREATE_TABLE_OBJ_TEST_B = {
	operation: 'create_table',
	schema: 'dev',
	table: 'test2',
	hash_attribute: 'id',
};

const TABLE_SYSTEM_DATA_TEST_B = {
	name: CREATE_TABLE_OBJ_TEST_B.table,
	schema: CREATE_TABLE_OBJ_TEST_B.schema,
	id: '82j3r478',
	hash_attribute: CREATE_TABLE_OBJ_TEST_B.hash_attribute,
	residence: '*',
};

const INSERT_OBJECT_TEST = {
	operation: 'insert',
	schema: 'dev',
	table: 'test',
	records: [],
};

describe('test validateDropSchema module', () => {
	before(async () => {
		await fs.remove(BASE_PATH);
	});

	after(() => {});

	describe('test methods', () => {
		let timestamps = [];
		let hdb_schema_env;
		let hdb_table_env;
		let hdb_attribute_env;
		before(async function () {
			this.timeout(20000);

			timestamps = [];
			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
			await fs.mkdirp(SYSTEM_SCHEMA_PATH);
			await fs.mkdirp(DEV_SCHEMA_PATH);

			global.hdb_schema = {
				dev: {
					test: {
						attributes: [],
						hash_attribute: 'id',
						schema: 'dev',
						name: 'test',
					},
					test2: {
						attributes: [],
						hash_attribute: 'id',
						schema: 'dev',
						name: 'test2',
					},
					test3: {
						attributes: [],
						schema: 'dev',
						name: 'test3',
					},
				},
				system: systemSchema,
			};

			hdb_schema_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_schema.name);
			environment_utility.createDBI(hdb_schema_env, systemSchema.hdb_schema.hash_attribute, false);

			hdb_table_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_table.name);
			environment_utility.createDBI(hdb_table_env, systemSchema.hdb_table.hash_attribute, false);

			hdb_attribute_env = await environment_utility.createEnvironment(
				SYSTEM_SCHEMA_PATH,
				systemSchema.hdb_attribute.name
			);
			environment_utility.createDBI(hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, false);

			await lmdb_create_schema(CREATE_SCHEMA_DEV);

			await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A);
			global.hdb_schema.dev.test.attributes = [
				{ attribute: 'id' },
				{ attribute: '__updatedtime__' },
				{ attribute: '__createdtime__' },
			];

			for (let x = 0; x < 10; x++) {
				let start = x * 100;
				let object_chunk = test_data.slice(start, start + 100);
				INSERT_OBJECT_TEST.records = object_chunk;

				await lmdb_create_records(INSERT_OBJECT_TEST);
				await sleep(10);
				timestamps.push(Date.now());
			}

			global.hdb_schema.dev.test.attributes = [
				{ attribute: 'id' },
				{ attribute: 'temperature' },
				{ attribute: 'temperature_str' },
				{ attribute: 'city' },
				{ attribute: 'state' },
				{ attribute: '__updatedtime__' },
				{ attribute: '__createdtime__' },
			];

			await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_B, CREATE_TABLE_OBJ_TEST_B);
			global.hdb_schema.dev.test2.attributes = [
				{ attribute: 'id' },
				{ attribute: '__updatedtime__' },
				{ attribute: '__createdtime__' },
			];
		});

		after(async () => {
			let env1 = await environment_utility.openEnvironment(
				path.join(BASE_SCHEMA_PATH, CREATE_TABLE_OBJ_TEST_A.schema),
				CREATE_TABLE_OBJ_TEST_A.table
			);
			await env1.close();

			let env2 = await environment_utility.openEnvironment(
				path.join(BASE_SCHEMA_PATH, CREATE_TABLE_OBJ_TEST_B.schema),
				CREATE_TABLE_OBJ_TEST_B.table
			);
			await env2.close();

			let txn_env1 = await environment_utility.openEnvironment(
				path.join(BASE_TXN_PATH, CREATE_TABLE_OBJ_TEST_A.schema),
				CREATE_TABLE_OBJ_TEST_A.table,
				true
			);
			await txn_env1.close();

			let txn_env2 = await environment_utility.openEnvironment(
				path.join(BASE_TXN_PATH, CREATE_TABLE_OBJ_TEST_B.schema),
				CREATE_TABLE_OBJ_TEST_B.table,
				true
			);
			await txn_env2.close();

			await hdb_table_env.close();
			await hdb_schema_env.close();
			await hdb_attribute_env.close();

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('Test error is thrown with no hash attribute', async () => {
			let delete_before = { schema: 'dev', table: 'test3', date: new Date(timestamps[0]) };
			await test_utils.assertErrorAsync(
				delete_records_before,
				[delete_before],
				new Error(`Could not retrieve hash attribute for schema: dev table: test3`)
			);
		});

		it('Test delete where table has no records', async () => {
			let delete_before = { schema: 'dev', table: 'test2', date: new Date(timestamps[0]) };
			let results = await test_utils.assertErrorAsync(delete_records_before, [delete_before], undefined);
			assert.deepStrictEqual(results, undefined);
		});

		it('Test delete first chunk of records', async () => {
			let expected = {
				message: '100 of 100 records successfully deleted',
				deleted_hashes: [],
				skipped_hashes: [],
			};

			for (let x = 0; x < 100; x++) {
				expected.deleted_hashes.push(x);
			}

			let delete_before = { schema: 'dev', table: 'test', date: new Date(timestamps[0]).toISOString() };
			let results = await test_utils.assertErrorAsync(delete_records_before, [delete_before], undefined);
			assert.deepStrictEqual(results.message, expected.message);
			assert.deepStrictEqual(results.deleted_hashes.sort(), expected.deleted_hashes.sort());

			let search_obj = new SearchObject('dev', 'test', '__createdtime__', timestamps[0], undefined, ['id']);
			let search_result = await search_by_value(search_obj, hdb_terms.VALUE_SEARCH_COMPARATORS.LESS);
			assert.deepStrictEqual(search_result, []);

			search_obj = new SearchObject('dev', 'test', '__createdtime__', timestamps[2], undefined, ['id']);
			search_result = await search_by_value(search_obj, hdb_terms.VALUE_SEARCH_COMPARATORS.LESS);
			assert.deepStrictEqual(search_result.length, 200);

			//test no delete entry in txn log
			let txn_results = await lmdb_read_txn_log(new ReadTransactionLogObject('dev', 'test'));
			for (let x = 0, length = txn_results.length; x < length; x++) {
				assert(txn_results[x].operation !== 'delete');
			}
		});
	});
});
