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
const lmdb_create_records = rewire('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateRecords');
const lmdb_upsert_records = rewire('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbUpsertRecords');
const lmdb_process_rows = rewire('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/lmdbProcessRows');
const lmdb_create_schema = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
const lmdb_common = require('../../../../../utility/lmdb/commonUtility');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const search_utility = require('../../../../../utility/lmdb/searchUtility');
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');
const { TEST_WRITE_OPS_ERROR_MSGS } = require('../../../../commonTestErrors');

let insert_date = new Date();
insert_date.setMinutes(insert_date.getMinutes() - 10);
const INSERT_TIMESTAMP = insert_date.getTime();

const LMDBUpsertTransactionObject = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/LMDBUpsertTransactionObject');

const TIMESTAMP = Date.now();
const HASH_ATTRIBUTE_NAME = 'id';

const NEW_HASH_VALUE = 1001;
const LONG_CHAR_TEST =
	'z2xFuWBiQgjAAAzgAK80e35FCuFzNHpicBWzsWZW055mFHwBxdU5yE5KlTQRzcZ04UlBTdhzDrVn1k1fuQCN9' +
	'faotQUlygf8Hv3E89f2v3KRzAX5FylEKwv4GJpSoZbXpgJ1mhmOjGUCAh3sipI5rVV0yvz6dbkXOw7xE5XlCHBRnc3T6BVyHIlUmFdlBowy' +
	'vAy7MT49mg6wn5yCqPEPFkcva2FNRYSNxljmu1XxN65mTKiTw2lvM0Yl2o0';

const INSERT_OBJECT_TEST = {
	operation: 'insert',
	schema: 'dev',
	table: 'dog',
	records: [
		{
			name: 'Harper',
			breed: 'Mutt',
			id: 108,
			age: 5,
		},
		{
			name: 'Penny',
			breed: 'Mutt',
			id: 109,
			age: 5,
			height: 145,
		},
		{
			name: 'David',
			breed: 'Mutt',
			id: 112,
		},
		{
			name: 'Rob',
			breed: 'Mutt',
			id: 110,
			age: 5,
			height: 145,
		},
	],
};

let INSERT_HASHES = [108, 109, 112, 110];

const ALL_FETCH_ATTRIBUTES = ['__createdtime__', '__updatedtime__', 'age', 'breed', 'height', 'id', 'name'];

const NO_NEW_ATTR_TEST = ALL_FETCH_ATTRIBUTES.map((attr) => ({ attribute: attr }));

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

describe('Test lmdbUpsertRecords module', () => {
	let date_stub;
	let hdb_schema_env;
	let hdb_table_env;
	let hdb_attribute_env;
	const uuid_v4_stub = { v4: () => NEW_HASH_VALUE };
	let rw_process_rows;
	let rw_upsert_records;

	before(() => {
		date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
		rw_process_rows = lmdb_process_rows.__set__('uuid', uuid_v4_stub);
		rw_upsert_records = lmdb_upsert_records.__set__('lmdbProcessRows', lmdb_process_rows);
	});

	after(() => {
		rw_process_rows();
		rw_upsert_records();
		date_stub.restore();
	});

	describe('Test lmdbUpsertRecords function', () => {
		let m_time;
		let insert_m_time;
		let m_time_stub;
		let expected_timestamp_txn;
		let expected_hashes_txn;

		beforeEach(async function () {
			this.timeout(10000);
			date_stub.restore();
			date_stub = sandbox.stub(Date, 'now').returns(INSERT_TIMESTAMP);
			global.hdb_schema = {
				[SCHEMA_TABLE_TEST.schema]: {
					[SCHEMA_TABLE_TEST.name]: {
						attributes: NO_NEW_ATTR_TEST,
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

			m_time = TIMESTAMP;
			insert_m_time = m_time;
			m_time_stub = sandbox.stub(lmdb_common, 'getNextMonotonicTime').returns(m_time);

			let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
			await lmdb_create_records(insert_obj);

			let insert_txn_obj = new LMDBUpsertTransactionObject(insert_obj.records, m_time, INSERT_HASHES);
			expected_timestamp_txn = test_utils.assignObjecttoNullObject({
				[m_time]: [JSON.stringify(insert_txn_obj)],
			});

			expected_hashes_txn = Object.create(null);
			insert_obj.records.forEach((record) => {
				expected_hashes_txn[record[HASH_ATTRIBUTE_NAME]] = [m_time.toString()];
			});

			date_stub.restore();
			date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);

			m_time_stub.restore();
			m_time = TIMESTAMP;
			m_time_stub = sandbox.stub(lmdb_common, 'getNextMonotonicTime').returns(m_time);
		});

		afterEach(async () => {
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
			m_time_stub.restore();

			global.lmdb_map = undefined;
			delete global.hdb_schema;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('Test upsert w/ update on 1 existing row', async () => {
			const upsert_obj = {
				operation: 'upsert',
				schema: 'dev',
				table: 'dog',
				records: [
					{
						name: 'Beethoven',
						breed: 'St. Bernard',
						id: 110,
						height: undefined,
						age: 10,
					},
				],
			};

			let expected_return_result = {
				new_attributes: [],
				written_hashes: [110],
				schema_table: {
					attributes: NO_NEW_ATTR_TEST,
					hash_attribute: HASH_ATTRIBUTE_NAME,
					residence: undefined,
					schema: INSERT_OBJECT_TEST.schema,
					name: INSERT_OBJECT_TEST.table,
				},
				txn_time: m_time,
			};

			let expected_search = test_utils.assignObjecttoNullObject(upsert_obj.records[0]);
			expected_search.__createdtime__ = TIMESTAMP;
			expected_search.__updatedtime__ = TIMESTAMP;
			expected_search.height = null;

			let results = await test_utils.assertErrorAsync(lmdb_upsert_records, [upsert_obj], undefined);
			assert.deepStrictEqual(results, expected_return_result);

			let dog_env = await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[path.join(BASE_SCHEMA_PATH, INSERT_OBJECT_TEST.schema), INSERT_OBJECT_TEST.table],
				undefined
			);
			let record = test_utils.assertErrorSync(
				search_utility.searchByHash,
				[dog_env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, 110],
				undefined
			);
			assert.deepStrictEqual(record, expected_search);

			//make sure the height index does not have an entry for id 10
			let height_results = test_utils.assertErrorSync(search_utility.iterateDBI, [dog_env, 'height'], undefined);
			Object.keys(height_results).forEach((result) => {
				assert(result.indexOf(110) < 0);
			});
		});

		it('Test upsert with new record (hash attribute provided)', async () => {
			const upsert_obj = {
				operation: 'upsert',
				schema: 'dev',
				table: 'dog',
				records: [
					{
						id: 1,
						name: 'Mozart',
						breed: 'Chihuahua',
						height: undefined,
						age: 0,
					},
				],
			};

			let expected_return_result = {
				new_attributes: [],
				written_hashes: [1],
				schema_table: {
					attributes: NO_NEW_ATTR_TEST,
					hash_attribute: HASH_ATTRIBUTE_NAME,
					residence: undefined,
					schema: INSERT_OBJECT_TEST.schema,
					name: INSERT_OBJECT_TEST.table,
				},
				txn_time: m_time,
			};

			let expected_search = test_utils.assignObjecttoNullObject(upsert_obj.records[0]);
			expected_search.__createdtime__ = TIMESTAMP;
			expected_search.__updatedtime__ = TIMESTAMP;
			expected_search.height = null;

			let results = await test_utils.assertErrorAsync(lmdb_upsert_records, [upsert_obj], undefined);
			assert.deepStrictEqual(results, expected_return_result);

			let dog_env = await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[path.join(BASE_SCHEMA_PATH, INSERT_OBJECT_TEST.schema), INSERT_OBJECT_TEST.table],
				undefined
			);
			let record = test_utils.assertErrorSync(
				search_utility.searchByHash,
				[dog_env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, 1],
				undefined
			);
			assert.deepStrictEqual(record, expected_search);
		});

		it('Test upsert with new record (i.e. no hash attribute)', async () => {
			const upsert_obj = {
				operation: 'upsert',
				schema: 'dev',
				table: 'dog',
				records: [
					{
						name: 'Mozart',
						breed: 'Chihuahua',
						height: 112,
						age: 10,
					},
				],
			};

			let expected_return_result = {
				new_attributes: [],
				written_hashes: [NEW_HASH_VALUE],
				schema_table: {
					attributes: NO_NEW_ATTR_TEST,
					hash_attribute: HASH_ATTRIBUTE_NAME,
					residence: undefined,
					schema: INSERT_OBJECT_TEST.schema,
					name: INSERT_OBJECT_TEST.table,
				},
				txn_time: m_time,
			};

			let expected_search = test_utils.assignObjecttoNullObject(upsert_obj.records[0]);
			expected_search.__createdtime__ = TIMESTAMP;
			expected_search.__updatedtime__ = TIMESTAMP;
			expected_search[HASH_ATTRIBUTE_NAME] = NEW_HASH_VALUE;

			let results = await test_utils.assertErrorAsync(lmdb_upsert_records, [upsert_obj], undefined);
			assert.deepStrictEqual(results, expected_return_result);

			let dog_env = await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[path.join(BASE_SCHEMA_PATH, INSERT_OBJECT_TEST.schema), INSERT_OBJECT_TEST.table],
				undefined
			);
			let record = test_utils.assertErrorSync(
				search_utility.searchByHash,
				[dog_env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, NEW_HASH_VALUE],
				undefined
			);
			assert.deepStrictEqual(record, expected_search);
		});

		it('Test upsert w/ inserts and update', async () => {
			const upsert_obj = {
				operation: 'upsert',
				schema: 'dev',
				table: 'dog',
				records: [
					{
						name: 'Beethoven',
						breed: 'St. Bernard',
						id: 110,
						height: undefined,
						age: 10,
					},
					{
						id: 1,
						name: 'Mozart',
						breed: 'Chihuahua',
						height: 179,
						age: 0,
					},
					{
						id: NEW_HASH_VALUE,
						name: 'Brahms',
						breed: 'English Pointer',
						height: 95,
						age: 91,
					},
				],
			};

			let expected_return_result = {
				new_attributes: [],
				written_hashes: [110, 1, NEW_HASH_VALUE],
				schema_table: {
					attributes: NO_NEW_ATTR_TEST,
					hash_attribute: HASH_ATTRIBUTE_NAME,
					residence: undefined,
					schema: INSERT_OBJECT_TEST.schema,
					name: INSERT_OBJECT_TEST.table,
				},
				txn_time: m_time,
			};

			let expected_search1 = test_utils.assignObjecttoNullObject(upsert_obj.records[0]);
			expected_search1.__createdtime__ = TIMESTAMP;
			expected_search1.__updatedtime__ = TIMESTAMP;
			expected_search1.height = null;

			let expected_search2 = test_utils.assignObjecttoNullObject(upsert_obj.records[1]);
			expected_search2.__createdtime__ = TIMESTAMP;
			expected_search2.__updatedtime__ = TIMESTAMP;

			let expected_search3 = test_utils.assignObjecttoNullObject(upsert_obj.records[2]);
			expected_search3.__createdtime__ = TIMESTAMP;
			expected_search3.__updatedtime__ = TIMESTAMP;

			let results = await test_utils.assertErrorAsync(lmdb_upsert_records, [upsert_obj], undefined);
			assert.deepStrictEqual(results, expected_return_result);

			let dog_env = await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[path.join(BASE_SCHEMA_PATH, INSERT_OBJECT_TEST.schema), INSERT_OBJECT_TEST.table],
				undefined
			);

			let record1 = test_utils.assertErrorSync(
				search_utility.searchByHash,
				[dog_env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, 110],
				undefined
			);
			assert.deepStrictEqual(record1, expected_search1);

			let record2 = test_utils.assertErrorSync(
				search_utility.searchByHash,
				[dog_env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, 1],
				undefined
			);
			assert.deepStrictEqual(record2, expected_search2);

			let record3 = test_utils.assertErrorSync(
				search_utility.searchByHash,
				[dog_env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, NEW_HASH_VALUE],
				undefined
			);
			assert.deepStrictEqual(record3, expected_search3);

			//make sure the height index does not have an entry for id 10
			let height_results = test_utils.assertErrorSync(search_utility.iterateDBI, [dog_env, 'height'], undefined);
			Object.keys(height_results).forEach((result) => {
				assert(result.indexOf(110) < 0);
			});
		});

		it('Test upsert with new record (invalid hash value) - expect error', async () => {
			const upsert_obj = {
				operation: 'upsert',
				schema: 'dev',
				table: 'dog',
				records: [
					{
						id: '1/2',
						name: 'Mozart',
						breed: 'Chihuahua',
						height: undefined,
						age: 0,
					},
				],
			};

			const expected_err_values = test_utils.generateHDBError(
				TEST_WRITE_OPS_ERROR_MSGS.INVALID_FORWARD_SLASH_IN_HASH_ERR,
				400
			);
			await test_utils.assertErrorAsync(lmdb_upsert_records, [upsert_obj], expected_err_values);
		});

		it('Test upsert with new record (invalid long hash value) - expect error', async () => {
			const upsert_obj = {
				operation: 'upsert',
				schema: 'dev',
				table: 'dog',
				records: [
					{
						id: LONG_CHAR_TEST,
						name: 'Mozart',
						breed: 'Chihuahua',
						height: undefined,
						age: 0,
					},
				],
			};

			const expected_err_values = test_utils.generateHDBError(TEST_WRITE_OPS_ERROR_MSGS.HASH_VAL_LENGTH_ERR, 400);
			await test_utils.assertErrorAsync(lmdb_upsert_records, [upsert_obj], expected_err_values);
		});

		it('Test upsert with new record (invalid long attr name) - expect error', async () => {
			const upsert_obj = {
				operation: 'upsert',
				schema: 'dev',
				table: 'dog',
				records: [
					{
						id: 1,
						name: 'Mozart',
						breed: 'Chihuahua',
						height: undefined,
						[LONG_CHAR_TEST]: true,
						age: 0,
					},
				],
			};

			const expected_err_values = test_utils.generateHDBError(
				TEST_WRITE_OPS_ERROR_MSGS.ATTR_NAME_LENGTH_ERR(LONG_CHAR_TEST),
				400
			);
			await test_utils.assertErrorAsync(lmdb_upsert_records, [upsert_obj], expected_err_values);
		});

		it('Test upsert with null write object - expect error', async () => {
			const upsert_obj = null;

			const expected_err_values = test_utils.generateHDBError('invalid update parameters defined.', 400);
			await test_utils.assertErrorAsync(lmdb_upsert_records, [upsert_obj], expected_err_values);
		});
	});
});
