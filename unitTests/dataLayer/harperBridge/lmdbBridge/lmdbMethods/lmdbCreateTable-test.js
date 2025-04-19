'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
const path = require('path');

const LMDB_TEST_FOLDER_NAME = 'system';
const BASE_PATH = test_utils.getMockLMDBPath();
const BASE_TEST_PATH = path.join(BASE_PATH, LMDB_TEST_FOLDER_NAME);

const rewire = require('rewire');
const lmdb_create_schema = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = rewire('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const search_utility = require('../../../../../utility/lmdb/searchUtility');
const systemSchema = require('../../../../../json/systemSchema');
const env = require('../../../../../utility/environment/environmentManager');

const assert = require('assert');
const fs = require('fs-extra');

const sinon = require('sinon');
const hdb_terms = require('../../../../../utility/hdbTerms');

const sandbox = sinon.createSandbox();
const TIMESTAMP = Date.now();

const CREATE_SCHEMA_DEV = {
	operation: 'create_schema',
	schema: 'dev',
};

const CREATE_SCHEMA_PROD = {
	operation: 'create_schema',
	schema: 'prod',
};

const CREATE_TABLE_OBJ_TEST_A = {
	operation: 'create_table',
	schema: 'dev',
	table: 'catsdrool',
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
	schema: 'prod',
	table: 'coolDogNames',
	hash_attribute: 'name',
};

const CREATE_TABLE_OBJ_TEST_C = {
	operation: 'create_table',
	schema: 'prod',
	table: 'coolCatNames',
	hash_attribute: 'name',
};

const TABLE_SYSTEM_DATA_TEST_B = {
	name: CREATE_TABLE_OBJ_TEST_B.table,
	schema: CREATE_TABLE_OBJ_TEST_B.schema,
	id: 'fd23fds',
	hash_attribute: CREATE_TABLE_OBJ_TEST_B.hash_attribute,
	residence: '*',
};

const TABLE_SYSTEM_DATA_TEST_C = {
	name: CREATE_TABLE_OBJ_TEST_C.table,
	schema: CREATE_TABLE_OBJ_TEST_C.schema,
	id: 'fd23fdsc',
	hash_attribute: CREATE_TABLE_OBJ_TEST_C.hash_attribute,
	residence: '*',
};

const HDB_TABLE_ATTRIBUTES = ['id', 'name', 'hash_attribute', 'schema', 'residence'];
const HDB_ATTRIBUTE_ATTRIBUTES = ['id', 'schema', 'table', 'attribute', 'schema_table'];

describe('test lmdbCreateTable module', () => {
	let hdb_schema_env;
	let hdb_table_env;
	let hdb_attribute_env;
	let date_stub;
	before(async () => {
		global.lmdb_map = undefined;
		global.hdb_schema = { system: systemSchema };
		date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
		await fs.remove(test_utils.getMockLMDBPath());
		await fs.mkdirp(BASE_TEST_PATH);
		env.setProperty(hdb_terms.CONFIG_PARAMS.DATABASES, {
			prod: {
				path: path.join(BASE_PATH, 'alt-prod-path'),
				tables: {
					coolCatNames: {
						path: path.join(BASE_PATH, 'alt-table-path'),
					},
				},
			},
		});

		hdb_schema_env = await environment_utility.createEnvironment(BASE_TEST_PATH, systemSchema.hdb_schema.name);
		environment_utility.createDBI(hdb_schema_env, systemSchema.hdb_schema.hash_attribute, false);

		hdb_table_env = await environment_utility.createEnvironment(BASE_TEST_PATH, systemSchema.hdb_table.name);
		environment_utility.createDBI(hdb_table_env, systemSchema.hdb_table.hash_attribute, false);

		hdb_attribute_env = await environment_utility.createEnvironment(BASE_TEST_PATH, systemSchema.hdb_attribute.name);
		environment_utility.createDBI(hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, false);
		environment_utility.createDBI(hdb_attribute_env, 'schema_table', true);

		await lmdb_create_schema(CREATE_SCHEMA_DEV);
		await lmdb_create_schema(CREATE_SCHEMA_PROD);
	});

	after(async () => {
		await hdb_table_env.close();
		await hdb_schema_env.close();
		await hdb_attribute_env.close();

		date_stub.restore();
		delete global.hdb_schema;
		try {
			await fs.remove(BASE_PATH);
		} catch (error) {}
		global.lmdb_map = undefined;
	});

	it('Test creating a table under the dev schema', async () => {
		let expected_table = test_utils.assignObjecttoNullObject(TABLE_SYSTEM_DATA_TEST_A);
		let schema_path = path.join(BASE_PATH, CREATE_TABLE_OBJ_TEST_A.schema);
		let transactions_path = path.join(BASE_PATH, 'transactions');
		let table_path = path.join(schema_path, CREATE_TABLE_OBJ_TEST_A.table + '.mdb');
		let expected_attributes = ['__createdtime__', '__updatedtime__', 'id'];
		let expected_dbis = ['__createdtime__', '__updatedtime__', 'id'];

		await test_utils.assertErrorAsync(
			lmdb_create_table,
			[TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A],
			undefined
		);

		let new_env = await test_utils.assertErrorAsync(
			environment_utility.openEnvironment,
			[schema_path, CREATE_TABLE_OBJ_TEST_A.table],
			undefined
		);

		await test_utils.assertErrorAsync(fs.access, [table_path], undefined);

		let table_record = test_utils.assertErrorSync(
			search_utility.searchByHash,
			[hdb_table_env, systemSchema.hdb_table.hash_attribute, HDB_TABLE_ATTRIBUTES, TABLE_SYSTEM_DATA_TEST_A.id],
			undefined
		);
		assert.deepStrictEqual(table_record, expected_table);

		let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [new_env], undefined);

		assert.deepStrictEqual(all_dbis, expected_dbis);
		let attribute_ids = Array.from(
			test_utils.assertErrorSync(
				search_utility.equals,
				[
					hdb_attribute_env,
					'id',
					'schema_table',
					`${TABLE_SYSTEM_DATA_TEST_A.schema}.${TABLE_SYSTEM_DATA_TEST_A.name}`,
				],
				undefined
			)
		);

		let attribute_records = test_utils.assertErrorSync(
			search_utility.batchSearchByHash,
			[
				hdb_attribute_env,
				systemSchema.hdb_attribute.hash_attribute,
				HDB_ATTRIBUTE_ATTRIBUTES,
				attribute_ids.map((r) => r.value),
			],
			undefined
		);
		assert.deepStrictEqual(attribute_records.length, 3);
		attribute_records.forEach((record) => {
			assert(expected_attributes.indexOf(record.attribute) > -1);
		});

		await new_env.close();

		//validate the transactions environments
		let transaction_path = path.join(transactions_path, CREATE_TABLE_OBJ_TEST_A.schema);
		let table_transaction_path = path.join(
			transactions_path,
			CREATE_TABLE_OBJ_TEST_A.schema,
			CREATE_TABLE_OBJ_TEST_A.table + '.mdb'
		);
		let expected_txn_dbis = ['hash_value', 'timestamp', 'user_name'];
		await test_utils.assertErrorAsync(fs.access, [table_transaction_path], undefined);
		let txn_env = await test_utils.assertErrorAsync(
			environment_utility.openEnvironment,
			[transaction_path, CREATE_TABLE_OBJ_TEST_A.table, true],
			undefined
		);
		let txn_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [txn_env], undefined);

		assert.deepStrictEqual(txn_dbis, expected_txn_dbis);

		await txn_env.close();
	});

	it('Test creating a table under the prod schema', async () => {
		let expected_table = test_utils.assignObjecttoNullObject(TABLE_SYSTEM_DATA_TEST_B);
		let schema_path = path.join(BASE_PATH, 'alt-prod-path');
		let transactions_path = path.join(BASE_PATH, 'transactions');
		let table_path = path.join(schema_path, CREATE_TABLE_OBJ_TEST_B.table + '.mdb');
		let table_path_c = path.join(path.join(BASE_PATH, 'alt-table-path'), CREATE_TABLE_OBJ_TEST_C.table + '.mdb');
		let expected_attributes = ['__createdtime__', '__updatedtime__', 'name'];

		await fs.mkdirp(path.join(BASE_PATH, 'alt-table-path'));
		await test_utils.assertErrorAsync(
			lmdb_create_table,
			[TABLE_SYSTEM_DATA_TEST_C, CREATE_TABLE_OBJ_TEST_C],
			undefined
		);

		let new_env = await test_utils.assertErrorAsync(
			environment_utility.openEnvironment,
			[path.join(BASE_PATH, 'alt-table-path'), CREATE_TABLE_OBJ_TEST_C.table],
			undefined
		);

		await test_utils.assertErrorAsync(fs.access, [table_path_c], undefined);
		await new_env.close();

		await test_utils.assertErrorAsync(
			lmdb_create_table,
			[TABLE_SYSTEM_DATA_TEST_B, CREATE_TABLE_OBJ_TEST_B],
			undefined
		);

		new_env = await test_utils.assertErrorAsync(
			environment_utility.openEnvironment,
			[schema_path, CREATE_TABLE_OBJ_TEST_B.table],
			undefined
		);

		await test_utils.assertErrorAsync(fs.access, [table_path], undefined);

		let table_record = test_utils.assertErrorSync(
			search_utility.searchByHash,
			[hdb_table_env, systemSchema.hdb_table.hash_attribute, HDB_TABLE_ATTRIBUTES, TABLE_SYSTEM_DATA_TEST_B.id],
			undefined
		);
		assert.deepStrictEqual(table_record, expected_table);

		let all_dbis = await test_utils.assertErrorAsync(environment_utility.listDBIs, [new_env], undefined);

		assert.deepStrictEqual(all_dbis, expected_attributes);
		let attribute_ids = Array.from(
			await test_utils.assertErrorAsync(
				search_utility.equals,
				[
					hdb_attribute_env,
					systemSchema.hdb_attribute.hash_attribute,
					'schema_table',
					`${TABLE_SYSTEM_DATA_TEST_B.schema}.${TABLE_SYSTEM_DATA_TEST_B.name}`,
				],
				undefined
			)
		);

		let attribute_records = await test_utils.assertErrorAsync(
			search_utility.batchSearchByHash,
			[
				hdb_attribute_env,
				systemSchema.hdb_attribute.hash_attribute,
				HDB_ATTRIBUTE_ATTRIBUTES,
				attribute_ids.map((r) => r.value),
			],
			undefined
		);
		assert.deepStrictEqual(attribute_records.length, 3);
		attribute_records.forEach((record) => {
			assert(expected_attributes.indexOf(record.attribute) > -1);
		});

		await new_env.close();

		//validate the transactions environments
		let transaction_path = path.join(transactions_path, CREATE_TABLE_OBJ_TEST_B.schema);
		let table_transaction_path = path.join(transaction_path, CREATE_TABLE_OBJ_TEST_B.table + '.mdb');
		let expected_txn_dbis = ['hash_value', 'timestamp', 'user_name'];
		await test_utils.assertErrorAsync(fs.access, [table_transaction_path], undefined);
		let txn_env = await test_utils.assertErrorAsync(
			environment_utility.openEnvironment,
			[transaction_path, CREATE_TABLE_OBJ_TEST_B.table, true],
			undefined
		);
		let txn_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [txn_env], undefined);
		await txn_env.close();
		assert.deepStrictEqual(txn_dbis, expected_txn_dbis);
	});

	it('Test that error from lmdbCreateRecords is caught', async () => {
		let error_msg = new Error('I am broken');
		let rw = lmdb_create_table.__set__('writeUtility', {
			insertRecords: () => {
				throw error_msg;
			},
		});

		await test_utils.assertErrorAsync(
			lmdb_create_table,
			[TABLE_SYSTEM_DATA_TEST_B, CREATE_TABLE_OBJ_TEST_B],
			error_msg
		);

		rw();
	});
});
