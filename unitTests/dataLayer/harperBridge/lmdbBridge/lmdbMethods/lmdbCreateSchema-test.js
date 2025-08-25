'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
const path = require('path');

const LMDB_TEST_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockLMDBPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH);
const BASE_TEST_PATH = path.join(BASE_SCHEMA_PATH, LMDB_TEST_FOLDER_NAME);
const TEST_ENVIRONMENT_NAME = 'hdb_schema';
const HASH_ATTRIBUTE_NAME = 'name';

const rewire = require('rewire');
const lmdb_create_schema = rewire('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const search_utility = require('../../../../../utility/lmdb/searchUtility');
const systemSchema = require('../../../../../json/systemSchema');
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');

const sandbox = sinon.createSandbox();
const TIMESTAMP = Date.now();

const CREATE_SCHEMA_OBJ_TEST_A = {
	operation: 'create_schema',
	schema: 'horses',
};

describe('test lmdbCreateSchema module', () => {
	let env;
	let date_stub;
	before(async () => {
		global.hdb_schema = { system: systemSchema };
		date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
		await fs.mkdirp(BASE_TEST_PATH);

		env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
		environment_utility.createDBI(env, HASH_ATTRIBUTE_NAME, false);
	});

	after(async () => {
		await env.close();
		date_stub.restore();
		delete global.hdb_schema;

		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
	});

	it('Test that a new schema is added to the system datastore', async () => {
		let expected_search_result = test_utils.assignObjecttoNullObject({ name: 'horses', createddate: TIMESTAMP });

		await test_utils.assertErrorAsync(lmdb_create_schema, [CREATE_SCHEMA_OBJ_TEST_A], undefined);

		let result = test_utils.assertErrorSync(
			search_utility.searchByHash,
			[env, HASH_ATTRIBUTE_NAME, ['name', 'createddate'], CREATE_SCHEMA_OBJ_TEST_A.schema],
			undefined
		);
		assert.deepStrictEqual(result, expected_search_result);

		await test_utils.assertErrorAsync(
			fs.access,
			[path.join(BASE_SCHEMA_PATH, CREATE_SCHEMA_OBJ_TEST_A.schema)],
			undefined
		);
	});

	it('Test that error from lmdbCreateRecords caught and thrown', async () => {
		let error_msg = new Error('Error creating the record');
		let rw_create_records = lmdb_create_schema.__set__('lmdbCreateRecords', async () => {
			throw error_msg;
		});
		await test_utils.assertErrorAsync(lmdb_create_schema, [CREATE_SCHEMA_OBJ_TEST_A], error_msg);
		rw_create_records();
	});
});
