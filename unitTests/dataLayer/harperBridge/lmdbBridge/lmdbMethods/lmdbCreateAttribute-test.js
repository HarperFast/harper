'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const path = require('path');
const LMDB_TEST_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockLMDBPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const BASE_TXN_PATH = path.join(BASE_PATH, 'transactions');
const BASE_TEST_PATH = path.join(BASE_SCHEMA_PATH, LMDB_TEST_FOLDER_NAME);

const rewire = require('rewire');
const harperBridge = require('../../../../../dataLayer/harperBridge/harperBridge');
const lmdb_create_schema = harperBridge.createSchema;
const lmdb_create_table = harperBridge.createTable;
const lmdb_create_attribute = harperBridge.createAttribute;
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const search_utility = require('../../../../../utility/lmdb/searchUtility');
const systemSchema = require('../../../../../json/systemSchema');

const assert = require('assert');
const fs = require('fs-extra');

const MOCK_UUID_VALUE = 'cool-uuid-value';

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

const TABLE_SYSTEM_DATA_TEST_B = {
	name: CREATE_TABLE_OBJ_TEST_B.table,
	schema: CREATE_TABLE_OBJ_TEST_B.schema,
	id: 'fd23fds',
	hash_attribute: CREATE_TABLE_OBJ_TEST_B.hash_attribute,
	residence: '*',
};

const CREATE_ATTR_OBJ_TEST = {
	operation: 'create_attribute',
	schema: 'dev',
	table: 'catsdrool',
	attribute: 'another_attribute',
	id: MOCK_UUID_VALUE,
};

const HDB_ATTRIBUTE_ATTRIBUTES = ['id', 'schema', 'table', 'attribute', 'schema_table'];

describe('test lmdbCreateAttribute module', () => {
	let hdb_schema_env;
	let hdb_table_env;
	let hdb_attribute_env;
	let rw_env_util;
	let catsdrool_env;
	before(async () => {
		//uuid_stub = sandbox.stub(uuid, 'v4').returns(MOCK_UUID_VALUE);
		global.hdb_schema = { system: systemSchema, dev: { catsdrool: {} } };
		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
		await fs.mkdirp(BASE_TEST_PATH);

		hdb_schema_env = await environment_utility.createEnvironment(BASE_TEST_PATH, systemSchema.hdb_schema.name);
		environment_utility.createDBI(hdb_schema_env, systemSchema.hdb_schema.hash_attribute, false, true);

		hdb_table_env = await environment_utility.createEnvironment(BASE_TEST_PATH, systemSchema.hdb_table.name);
		environment_utility.createDBI(hdb_table_env, systemSchema.hdb_table.hash_attribute, false, true);

		hdb_attribute_env = await environment_utility.createEnvironment(BASE_TEST_PATH, systemSchema.hdb_attribute.name);
		environment_utility.createDBI(hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, false, true);

		await lmdb_create_schema(CREATE_SCHEMA_DEV);
		await lmdb_create_schema(CREATE_SCHEMA_PROD);
		await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A);
		await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_B, CREATE_TABLE_OBJ_TEST_B);
		catsdrool_env = await environment_utility.openEnvironment(
			path.join(BASE_SCHEMA_PATH, CREATE_TABLE_OBJ_TEST_A.schema),
			CREATE_TABLE_OBJ_TEST_A.table
		);
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

		delete global.hdb_schema;
		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
	});

	it('Test that a datastore is created and system schema updated with new attribute', async () => {
		const test_create_attr_obj = { ...CREATE_ATTR_OBJ_TEST };
		let expected_result = {
			message: 'inserted 1 of 1 records',
			skipped_hashes: [],
			inserted_hashes: [MOCK_UUID_VALUE],
		};

		let expected_search_result = test_utils.assignObjecttoNullObject({
			id: MOCK_UUID_VALUE,
			schema: CREATE_ATTR_OBJ_TEST.schema,
			table: CREATE_ATTR_OBJ_TEST.table,
			attribute: CREATE_ATTR_OBJ_TEST.attribute,
			schema_table: `${CREATE_ATTR_OBJ_TEST.schema}.${CREATE_ATTR_OBJ_TEST.table}`,
		});

		let results = await test_utils.assertErrorAsync(lmdb_create_attribute, [test_create_attr_obj], undefined);
		assert.deepStrictEqual(results, expected_result);

		let test_env = await test_utils.assertErrorAsync(
			environment_utility.openEnvironment,
			[path.join(BASE_SCHEMA_PATH, CREATE_ATTR_OBJ_TEST.schema), CREATE_ATTR_OBJ_TEST.table],
			undefined
		);
		let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [test_env], undefined);
		assert(all_dbis.includes(CREATE_ATTR_OBJ_TEST.attribute) === true);

		let attribute_record = test_utils.assertErrorSync(
			search_utility.searchByHash,
			[hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, HDB_ATTRIBUTE_ATTRIBUTES, MOCK_UUID_VALUE],
			undefined
		);
		assert.deepStrictEqual(attribute_record, expected_search_result);
	});

	it('Test that a datastore is created with dup_sort set to true when undefined in create_attribute_obj', async () => {
		const test_create_attr_obj = { ...CREATE_ATTR_OBJ_TEST };
		test_create_attr_obj.attribute = 'attr1';
		delete test_create_attr_obj.id;
		assert.equal(test_create_attr_obj.dup_sort, undefined);

		await lmdb_create_attribute(test_create_attr_obj);
		assert.ok(test_create_attr_obj.dup_sort);

		let dbi = environment_utility.openDBI(catsdrool_env, 'attr1');
		assert.ok(dbi.dupSort);
	});

	it('Test that a datastore is created with dup_sort set to true when null in create_attribute_obj', async () => {
		const test_create_attr_obj = { ...CREATE_ATTR_OBJ_TEST };
		test_create_attr_obj.dup_sort = null;
		test_create_attr_obj.attribute = 'attr2';
		delete test_create_attr_obj.id;
		await lmdb_create_attribute(test_create_attr_obj);
		assert.ok(test_create_attr_obj.dup_sort);

		let dbi = environment_utility.openDBI(catsdrool_env, 'attr2');
		assert.ok(dbi.dupSort);
	});

	it('Test that a datastore is created with dup_sort set to true when true boolean used in create_attribute_obj', async () => {
		const test_create_attr_obj = { ...CREATE_ATTR_OBJ_TEST };
		test_create_attr_obj.dup_sort = true;
		test_create_attr_obj.attribute = 'attr3';
		delete test_create_attr_obj.id;
		await lmdb_create_attribute(test_create_attr_obj);
		assert.ok(test_create_attr_obj.dup_sort);

		let dbi = environment_utility.openDBI(catsdrool_env, 'attr3');
		assert.ok(dbi.dupSort);
	});

	it('Test that a datastore is created with dup_sort set to false when false boolean used in create_attribute_obj', async () => {
		const test_create_attr_obj = { ...CREATE_ATTR_OBJ_TEST };
		test_create_attr_obj.dup_sort = false;
		test_create_attr_obj.attribute = 'attr4';
		delete test_create_attr_obj.id;
		await lmdb_create_attribute(test_create_attr_obj);
		assert.equal(test_create_attr_obj.dup_sort, false);

		let dbi = environment_utility.openDBI(catsdrool_env, 'attr4');
		assert.ok(!dbi.dupSort);
	});

	it('Test that datastore is not created because it already exists', async () => {
		const test_create_attr_obj = { ...CREATE_ATTR_OBJ_TEST };
		await test_utils.assertErrorAsync(
			lmdb_create_attribute,
			[test_create_attr_obj],
			new Error("attribute 'another_attribute' already exists in dev.catsdrool")
		);
	});

	it('Test that validation error is thrown', async () => {
		let attr_required = test_utils.generateHDBError('Attribute is required', 400);
		let create_attr_obj = test_utils.deepClone(CREATE_ATTR_OBJ_TEST);
		delete create_attr_obj.attribute;
		await test_utils.assertErrorAsync(lmdb_create_attribute, [create_attr_obj], attr_required);

		create_attr_obj = test_utils.deepClone(CREATE_ATTR_OBJ_TEST);
		create_attr_obj.attribute = null;
		await test_utils.assertErrorAsync(lmdb_create_attribute, [create_attr_obj], attr_required);

		create_attr_obj = test_utils.deepClone(CREATE_ATTR_OBJ_TEST);
		create_attr_obj.attribute = undefined;
		await test_utils.assertErrorAsync(lmdb_create_attribute, [create_attr_obj], attr_required);

		create_attr_obj = test_utils.deepClone(CREATE_ATTR_OBJ_TEST);
		create_attr_obj.attribute = '';
		await test_utils.assertErrorAsync(
			lmdb_create_attribute,
			[create_attr_obj],
			test_utils.generateHDBError('Attribute is too short (minimum is 1 characters)', 400)
		);

		create_attr_obj = test_utils.deepClone(CREATE_ATTR_OBJ_TEST);
		create_attr_obj.attribute = 'slash/er';
		await test_utils.assertErrorAsync(
			lmdb_create_attribute,
			[create_attr_obj],
			test_utils.generateHDBError('Attribute names cannot include backticks or forward slashes', 400)
		);

		create_attr_obj = { operation: 'create_attribute' };
		await test_utils.assertErrorAsync(
			lmdb_create_attribute,
			[create_attr_obj],
			test_utils.generateHDBError('Schema is required,Table is required,Attribute is required', 400)
		);
	});
});
