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

const rewire = require('rewire');
const bridge = require('../../../../../dataLayer/harperBridge/harperBridge');
const lmdb_create_records = bridge.createRecords;
const lmdb_search_by_hash = bridge.searchByHash;
const lmdb_create_schema = bridge.createSchema;
const lmdb_create_table = bridge.createTable;
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const SearchByHashObject = require('../../../../../dataLayer/SearchByHashObject');
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');
const common = require('../../../../../utility/lmdb/commonUtility');
const { resetDatabases } = require('../../../../../resources/databases');

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

describe('Test lmdbSearchDataByHash module', () => {
	let date_stub;
	let hdb_schema_env;
	let hdb_table_env;
	let hdb_attribute_env;
	before(() => {
		date_stub = sandbox.stub(common, 'getNextMonotonicTime').returns(TIMESTAMP);
	});

	after(() => {
		date_stub.restore();
	});

	describe('Test lmdbGetDataByHash function', () => {
		before(async () => {
			global.hdb_schema = {
				[SCHEMA_TABLE_TEST.schema]: {
					[SCHEMA_TABLE_TEST.name]: {
						attributes: ALL_FETCH_ATTRIBUTES,
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

			let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
			await lmdb_create_records(insert_obj);
			resetDatabases();
		});

		after(async () => {
			let env = await environment_utility.openEnvironment(
				path.join(BASE_SCHEMA_PATH, CREATE_TABLE_OBJ_TEST_A.schema),
				CREATE_TABLE_OBJ_TEST_A.table
			);
			await env.close();

			let txn_env1 = await environment_utility.openEnvironment(
				path.join(BASE_TXN_PATH, CREATE_TABLE_OBJ_TEST_A.schema),
				CREATE_TABLE_OBJ_TEST_A.table,
				true
			);
			await txn_env1.close();

			await hdb_schema_env.close();
			await hdb_table_env.close();
			await hdb_attribute_env.close();

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
			delete global.hdb_schema;
		});

		it('test validation', async () => {
			await toArrayWithAssertError(
				lmdb_search_by_hash,
				[{}],
				new Error("'schema' is required. 'table' is required. 'hash_values' is required. 'get_attributes' is required")
			);

			let search_obj = new SearchByHashObject('dev');
			await toArrayWithAssertError(
				lmdb_search_by_hash,
				[search_obj],
				new Error("'table' is required. 'hash_values' is required. 'get_attributes' is required")
			);

			search_obj = new SearchByHashObject('dev', 'dog');
			await toArrayWithAssertError(
				lmdb_search_by_hash,
				[search_obj],
				new Error("'hash_values' is required. 'get_attributes' is required")
			);

			search_obj = new SearchByHashObject('dev', 'dog', [8]);
			await toArrayWithAssertError(lmdb_search_by_hash, [search_obj], new Error("'get_attributes' is required"));

			search_obj = new SearchByHashObject('dev', 'dog', [8], ALL_FETCH_ATTRIBUTES);
			await toArrayWithAssertError(lmdb_search_by_hash, [search_obj], undefined);

			search_obj = new SearchByHashObject('dev', 'dog', 8, ALL_FETCH_ATTRIBUTES);
			await toArrayWithAssertError(lmdb_search_by_hash, [search_obj], new Error("'hash_values' must be an array"));

			search_obj = new SearchByHashObject('dev', 'dog', [8], 'test');
			await toArrayWithAssertError(lmdb_search_by_hash, [search_obj], new Error("'get_attributes' must be an array"));

			search_obj = new SearchByHashObject('dev', 'dog', [8], []);
			await toArrayWithAssertError(
				lmdb_search_by_hash,
				[search_obj],
				new Error("'get_attributes' must contain at least 1 item")
			);
		});

		it('test finding 1 row', async () => {
			let exp_obj = test_utils.deepClone(INSERT_OBJECT_TEST.records[0]);
			exp_obj.__updatedtime__ = TIMESTAMP;
			exp_obj.__createdtime__ = TIMESTAMP;
			exp_obj.height = null;
			let expected_result = [{ ...exp_obj }];

			let search_obj = new SearchByHashObject('dev', 'dog', [8], ALL_FETCH_ATTRIBUTES);
			let results = await toArrayWithAssertError(lmdb_search_by_hash, [search_obj], undefined);

			assert.deepStrictEqual(results, expected_result);
		});

		it('test finding 1 row some attributes', async () => {
			let expected_result = [{ name: 'Harper' }];

			let search_obj = new SearchByHashObject('dev', 'dog', [8], ['name']);
			let results = await toArrayWithAssertError(lmdb_search_by_hash, [search_obj], undefined);

			assert.deepStrictEqual(results, expected_result);
		});

		it('test finding multiple rows row, some attributes', async () => {
			let expected_result = [
				{ id: 10, height: 145 },
				{ id: 8, height: null },
			];

			let search_obj = new SearchByHashObject('dev', 'dog', [10, 8], ['id', 'height']);
			let results = await toArrayWithAssertError(lmdb_search_by_hash, [search_obj], undefined);

			assert.deepStrictEqual(results, expected_result);
		});
	});
});
async function toArrayWithAssertError(test_func, args, error_object, message) {
	let response = await test_utils.assertErrorAsync(test_func, args, error_object, message);
	response = await response;
	if (response && response[Symbol.asyncIterator] && !response[Symbol.iterator]) {
		// requires async iteration to access elements
		let array = [];
		for await (let element of response) {
			array.push(element);
		}
		return array;
	}
	return response;
}
