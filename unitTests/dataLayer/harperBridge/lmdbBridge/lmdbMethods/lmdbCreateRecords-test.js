'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
const path = require('path');

const SYSTEM_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const TRANSACTIONS_NAME = 'transactions';
const BASE_PATH = test_utils.getMockLMDBPath();
const BASE_TXN_PATH = path.join(BASE_PATH, TRANSACTIONS_NAME);
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, SYSTEM_FOLDER_NAME);

const rewire = require('rewire');
const lmdb_create_records = rewire('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateRecords');
const lmdb_create_schema = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const search_utility = require('../../../../../utility/lmdb/searchUtility');
const verify_txn = require('../_verifyTxns');
const lmdb_common = require('../../../../../utility/lmdb/commonUtility');
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');
const env_manager = require('../../../../../utility/environment/environmentManager');
const hdb_terms = require('../../../../../utility/hdbTerms');

const LMDBInsertTransactionObject = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/LMDBInsertTransactionObject');

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

const EXPECTED_SEARCH_RECORDS = [
	{
		__createdtime__: TIMESTAMP,
		__updatedtime__: TIMESTAMP,
		name: 'Harper',
		breed: 'Mutt',
		height: null,
		id: 8,
		age: 5,
	},
	{
		__createdtime__: TIMESTAMP,
		__updatedtime__: TIMESTAMP,
		name: 'Penny',
		breed: 'Mutt',
		id: 9,
		age: 5,
		height: 145,
	},
	{
		__createdtime__: TIMESTAMP,
		__updatedtime__: TIMESTAMP,
		name: 'Rob',
		breed: 'Mutt',
		id: 10,
		age: 5,
		height: 145,
	},
	{
		__createdtime__: TIMESTAMP,
		__updatedtime__: TIMESTAMP,
		age: null,
		name: 'David',
		breed: 'Mutt',
		height: null,
		id: 12,
	},
];

const NO_NEW_ATTR_TEST = [
	{
		attribute: 'name',
	},
	{
		attribute: 'breed',
	},
	{
		attribute: 'age',
	},
	{
		attribute: 'id',
	},
	{
		attribute: 'height',
	},
	{
		attribute: '__createdtime__',
	},
	{
		attribute: '__updatedtime__',
	},
];

const ALL_FETCH_ATTRIBUTES = ['__createdtime__', '__updatedtime__', 'age', 'breed', 'height', 'id', 'name'];

const SCHEMA_TABLE_TEST = {
	id: 'c43762be-4943-4d10-81fb-1b857ed6cf3a',
	name: 'dog',
	hash_attribute: HASH_ATTRIBUTE_NAME,
	schema: 'dev',
	attributes: [{ attribute: HASH_ATTRIBUTE_NAME }, { attribute: '__createdtime__' }, { attribute: '__updatedtime__' }],
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

const TXN_SCHEMA_PATH = path.join(BASE_TXN_PATH, 'dev');

const TABLE_SYSTEM_DATA_TEST_A = {
	name: CREATE_TABLE_OBJ_TEST_A.table,
	schema: CREATE_TABLE_OBJ_TEST_A.schema,
	id: '82j3r4',
	hash_attribute: CREATE_TABLE_OBJ_TEST_A.hash_attribute,
	residence: '*',
};

const sandbox = sinon.createSandbox();

describe('Test lmdbCreateRecords module', () => {
	let date_stub;
	let hdb_schema_env;
	let hdb_table_env;
	let hdb_attribute_env;
	before(() => {
		date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_AUDITLOG, true);
	});

	after(() => {
		date_stub.restore();
	});

	describe('Test lmdbCreateRecords function', () => {
		let m_time;
		let m_time_stub;
		beforeEach(async () => {
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
			m_time_stub = sandbox.stub(lmdb_common, 'getNextMonotonicTime').returns(m_time);
		});

		afterEach(async () => {
			let env1 = await environment_utility.openEnvironment(
				path.join(BASE_SCHEMA_PATH, CREATE_TABLE_OBJ_TEST_A.schema),
				CREATE_TABLE_OBJ_TEST_A.table
			);
			await env1.close();

			let txn_env1 = await environment_utility.openEnvironment(
				path.join(BASE_TXN_PATH, CREATE_TABLE_OBJ_TEST_A.schema),
				CREATE_TABLE_OBJ_TEST_A.table,
				true
			);
			await txn_env1.close();

			await hdb_table_env.close();
			await hdb_schema_env.close();
			await hdb_attribute_env.close();

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
			delete global.hdb_schema;
			m_time_stub.restore();
		});

		it('Test that rows are inserted correctly and return msg is correct ', async () => {
			let expected_return_result = {
				new_attributes: ['name', 'breed', 'age', 'height'],
				written_hashes: [8, 9, 12, 10],
				skipped_hashes: [],
				txn_time: m_time,
				schema_table: {
					attributes: SCHEMA_TABLE_TEST.attributes,
					hash_attribute: HASH_ATTRIBUTE_NAME,
					residence: undefined,
					schema: INSERT_OBJECT_TEST.schema,
					name: INSERT_OBJECT_TEST.table,
				},
			};

			let expected_search = [];
			EXPECTED_SEARCH_RECORDS.forEach((record) => {
				expected_search.push(test_utils.assignObjecttoNullObject(record));
			});

			let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);

			//verify no transactions
			await verify_txn(TXN_SCHEMA_PATH, INSERT_OBJECT_TEST.table);

			let results = await test_utils.assertErrorAsync(lmdb_create_records, [insert_obj], undefined);
			assert.deepStrictEqual(results, expected_return_result);

			let dog_env = await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[path.join(BASE_SCHEMA_PATH, INSERT_OBJECT_TEST.schema), INSERT_OBJECT_TEST.table],
				undefined
			);
			let records = test_utils.assertErrorSync(
				search_utility.batchSearchByHash,
				[dog_env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, [8, 9, 12, 10]],
				undefined
			);
			records.sort((a, b) => (a.id > b.id ? 1 : -1));
			assert.deepStrictEqual(records, expected_search);

			//verify txn created
			let insert_txn_obj = {
				...new LMDBInsertTransactionObject(insert_obj.records, undefined, m_time, INSERT_HASHES),
			};
			let expected_timestamp = test_utils.assignObjecttoNullObject({
				[m_time]: [insert_txn_obj],
			});

			let hashes = Object.create(null);
			insert_obj.records.forEach((record) => {
				hashes[record[HASH_ATTRIBUTE_NAME]] = [m_time];
			});
			await verify_txn(TXN_SCHEMA_PATH, INSERT_OBJECT_TEST.table, expected_timestamp, hashes);
		});

		it('Test inserting existing and non-existing rows', async () => {
			let expected_result = {
				new_attributes: ['name', 'breed', 'age', 'height'],
				written_hashes: [8, 9, 12, 10],
				skipped_hashes: [],
				schema_table: {
					attributes: SCHEMA_TABLE_TEST.attributes,
					hash_attribute: HASH_ATTRIBUTE_NAME,
					residence: undefined,
					schema: INSERT_OBJECT_TEST.schema,
					name: INSERT_OBJECT_TEST.table,
				},
				txn_time: m_time,
			};

			//verify no transactions
			await verify_txn(TXN_SCHEMA_PATH, INSERT_OBJECT_TEST.table);

			let insert_obj1 = test_utils.deepClone(INSERT_OBJECT_TEST);

			let results = await test_utils.assertErrorAsync(lmdb_create_records, [insert_obj1], undefined);
			assert.deepStrictEqual(results, expected_result);

			//verify txn created
			let insert_txn_obj = {
				...new LMDBInsertTransactionObject(insert_obj1.records, undefined, m_time, INSERT_HASHES),
			};
			let expected_timestamp = test_utils.assignObjecttoNullObject({
				[m_time]: [insert_txn_obj],
			});

			let hashes = Object.create(null);
			insert_obj1.records.forEach((record) => {
				hashes[record[HASH_ATTRIBUTE_NAME]] = [m_time];
			});
			await verify_txn(TXN_SCHEMA_PATH, INSERT_OBJECT_TEST.table, expected_timestamp, hashes);

			insert_obj1.records.forEach((record) => {
				assert.deepStrictEqual(record.__updatedtime__, TIMESTAMP);
				assert.deepStrictEqual(record.__createdtime__, TIMESTAMP);
			});

			global.hdb_schema[SCHEMA_TABLE_TEST.schema][SCHEMA_TABLE_TEST.name]['attributes'] = NO_NEW_ATTR_TEST;
			let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
			let new_records = [
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
					id: 123,
				},
				{
					name: 'Rob',
					breed: 'Mutt',
					id: 1232,
					age: 5,
					height: 145,
				},
			];

			//change the expected microtime
			m_time_stub.restore();
			let first_time = m_time;
			m_time++;
			m_time_stub = sandbox.stub(lmdb_common, 'getNextMonotonicTime').returns(m_time);

			let new_records_excpected = [
				test_utils.assignObjecttoNullObject({
					__createdtime__: first_time,
					__updatedtime__: first_time,
					name: 'Harper',
					breed: 'Mutt',
					id: 8,
					height: null,
					age: 5,
				}),
				test_utils.assignObjecttoNullObject({
					__createdtime__: first_time,
					__updatedtime__: first_time,
					name: 'Penny',
					breed: 'Mutt',
					id: 9,
					age: 5,
					height: 145,
				}),
				test_utils.assignObjecttoNullObject({
					__createdtime__: m_time,
					__updatedtime__: m_time,
					age: null,
					name: 'David',
					breed: 'Mutt',
					height: null,
					id: 123,
				}),
				test_utils.assignObjecttoNullObject({
					__createdtime__: m_time,
					__updatedtime__: m_time,
					name: 'Rob',
					breed: 'Mutt',
					id: 1232,
					age: 5,
					height: 145,
				}),
			];

			insert_obj.records = new_records;
			let expected_return_result = {
				new_attributes: [],
				written_hashes: [123, 1232],
				skipped_hashes: [8, 9],
				schema_table: {
					attributes: NO_NEW_ATTR_TEST,
					hash_attribute: 'id',
					residence: undefined,
					schema: insert_obj.schema,
					name: insert_obj.table,
				},
				txn_time: m_time,
			};

			let result = await test_utils.assertErrorAsync(lmdb_create_records, [insert_obj], undefined);
			assert.deepStrictEqual(result.new_attributes, expected_return_result.new_attributes);
			assert.deepStrictEqual(result.written_hashes, expected_return_result.written_hashes);
			assert.deepStrictEqual(result.skipped_hashes, expected_return_result.skipped_hashes);
			assert.deepStrictEqual(result.schema_table.attributes, expected_return_result.schema_table.attributes);
			let dog_env = await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[path.join(BASE_SCHEMA_PATH, INSERT_OBJECT_TEST.schema), INSERT_OBJECT_TEST.table],
				undefined
			);
			let records = test_utils.assertErrorSync(
				search_utility.batchSearchByHash,
				[dog_env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, [8, 9, 123, 1232]],
				undefined
			);
			assert.deepStrictEqual(records, new_records_excpected);

			//verify txns
			let insert_txn_obj2 = {
				...new LMDBInsertTransactionObject(insert_obj.records, undefined, m_time, [123, 1232]),
			};
			expected_timestamp[m_time] = [insert_txn_obj2];

			insert_obj.records.forEach((record) => {
				hashes[record[HASH_ATTRIBUTE_NAME]] = [m_time];
			});
			await verify_txn(TXN_SCHEMA_PATH, INSERT_OBJECT_TEST.table, expected_timestamp, hashes);
		});

		it('Test inserting record with clustering', async () => {
			let expected_result = {
				new_attributes: ['name', 'breed', 'age'],
				written_hashes: [8],
				skipped_hashes: [],
				schema_table: {
					attributes: SCHEMA_TABLE_TEST.attributes,
					hash_attribute: HASH_ATTRIBUTE_NAME,
					residence: undefined,
					schema: INSERT_OBJECT_TEST.schema,
					name: INSERT_OBJECT_TEST.table,
				},
				txn_time: 123456,
			};

			//verify no transactions
			await verify_txn(TXN_SCHEMA_PATH, INSERT_OBJECT_TEST.table);

			let insert_obj1 = {
				operation: 'insert',
				schema: 'dev',
				table: 'dog',
				records: [
					{
						name: 'Harper',
						breed: 'Mutt',
						id: 8,
						age: 5,
						__createdtime__: 123456,
						__updatedtime__: 123456,
					},
				],
				__origin: {
					timestamp: 123456,
				},
			};

			let results = await test_utils.assertErrorAsync(lmdb_create_records, [insert_obj1], undefined);
			assert.deepStrictEqual(results, expected_result);

			//verify txn created
			let insert_txn_obj = {
				...new LMDBInsertTransactionObject(insert_obj1.records, undefined, 123456, [8], { timestamp: 123456 }),
			};
			let expected_timestamp = test_utils.assignObjecttoNullObject({
				[123456]: [insert_txn_obj],
			});

			let hashes = Object.create(null);
			insert_obj1.records.forEach((record) => {
				hashes[record[HASH_ATTRIBUTE_NAME]] = [123456];
			});
			await verify_txn(TXN_SCHEMA_PATH, INSERT_OBJECT_TEST.table, expected_timestamp, hashes);

			assert.deepStrictEqual(insert_obj1.records[0].__updatedtime__, 123456);
			assert.deepStrictEqual(insert_obj1.records[0].__createdtime__, 123456);
		});

		it('Test inserting rows that already exist', async () => {
			//verify no transactions
			await verify_txn(TXN_SCHEMA_PATH, INSERT_OBJECT_TEST.table);

			let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
			await test_utils.assertErrorAsync(lmdb_create_records, [insert_obj], undefined);

			//verify txn created
			let insert_txn_obj = {
				...new LMDBInsertTransactionObject(insert_obj.records, undefined, m_time, INSERT_HASHES),
			};
			let expected_timestamp = test_utils.assignObjecttoNullObject({
				[m_time]: [insert_txn_obj],
			});

			let hashes = Object.create(null);
			insert_obj.records.forEach((record) => {
				hashes[record[HASH_ATTRIBUTE_NAME]] = [m_time];
			});
			await verify_txn(TXN_SCHEMA_PATH, INSERT_OBJECT_TEST.table, expected_timestamp, hashes);

			let expected_result = {
				written_hashes: [],
				skipped_hashes: [8, 9, 12, 10],
				schema_table: {
					attributes: NO_NEW_ATTR_TEST,
					hash_attribute: 'id',
					residence: undefined,
					schema: insert_obj.schema,
					name: insert_obj.table,
				},
			};

			let insert_obj2 = test_utils.deepClone(INSERT_OBJECT_TEST);
			let results = await test_utils.assertErrorAsync(lmdb_create_records, [insert_obj2], undefined);
			assert.deepStrictEqual(results.written_hashes, expected_result.written_hashes);
			assert.deepStrictEqual(results.skipped_hashes, expected_result.skipped_hashes);

			//assert no new txns
			await verify_txn(TXN_SCHEMA_PATH, INSERT_OBJECT_TEST.table, expected_timestamp, hashes);
		});

		it('Test that no hash error from processRows is thrown', async () => {
			let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);

			insert_obj.records = [
				{
					name: 'Harper',
					breed: 'Mutt',
					id: 89,
					age: 5,
				},
				{
					name: 'Penny',
					breed: 'Mutt',
					age: 5,
					height: 145,
				},
			];
			insert_obj.operation = 'update';

			await test_utils.assertErrorAsync(
				lmdb_create_records,
				[insert_obj],
				new Error('a valid hash attribute must be provided with update record, check log for more info')
			);
		});
	});
});
