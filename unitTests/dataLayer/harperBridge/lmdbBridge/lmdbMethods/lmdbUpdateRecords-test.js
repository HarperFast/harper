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
const lmdb_update_records = rewire('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbUpdateRecords');
const lmdb_create_schema = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
const lmdb_common = require('../../../../../utility/lmdb/commonUtility');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const search_utility = require('../../../../../utility/lmdb/searchUtility');
const env_manager = require('../../../../../utility/environment/environmentManager');
const hdb_terms = require('../../../../../utility/hdbTerms');
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');
const verify_txn = require('../_verifyTxns');

let insert_date = new Date();
insert_date.setMinutes(insert_date.getMinutes() - 10);
const INSERT_TIMESTAMP = insert_date.getTime();

const LMDBInsertTransactionObject = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/LMDBInsertTransactionObject');
const LMDBUpdateTransactionObject = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/LMDBUpdateTransactionObject');

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

let INSERT_HASHES = [8, 9, 12, 10];

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
	attributes: [],
};

const CREATE_SCHEMA_DEV = {
	operation: 'create_schema',
	schema: 'dev',
};

const TXN_SCHEMA_PATH = path.join(BASE_TXN_PATH, 'dev');

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

describe('Test lmdbUpdateRecords module', () => {
	let date_stub;
	let hdb_schema_env;
	let hdb_table_env;
	let hdb_attribute_env;
	before(() => {
		//date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
		env_manager.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_AUDITLOG, true);
	});

	after(() => {
		//date_stub.restore();
	});

	describe('Test lmdbUpdateRecords function', () => {
		let m_time;
		let insert_m_time;
		let m_time_stub;
		let expected_timestamp_txn;
		let expected_hashes_txn;

		beforeEach(async () => {
			//date_stub.restore();
			//date_stub = sandbox.stub(Date, 'now').returns(INSERT_TIMESTAMP);
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

			let insert_txn_obj = new LMDBInsertTransactionObject(insert_obj.records, undefined, m_time, INSERT_HASHES);
			expected_timestamp_txn = test_utils.assignObjecttoNullObject({
				[m_time]: [insert_txn_obj],
			});

			expected_hashes_txn = Object.create(null);
			insert_obj.records.forEach((record) => {
				expected_hashes_txn[record[HASH_ATTRIBUTE_NAME]] = [m_time];
			});

			//date_stub.restore();
			//date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);

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

		it('Test updating 1 row', async () => {
			const update_obj = {
				operation: 'update',
				schema: 'dev',
				table: 'dog',
				records: [
					{
						name: 'Beethoven',
						breed: 'St. Bernard',
						id: 10,
						height: undefined,
						age: 10,
					},
				],
			};

			m_time_stub.restore();
			m_time = TIMESTAMP + 1;
			m_time_stub = sandbox.stub(lmdb_common, 'getNextMonotonicTime').returns(m_time);
			let expected_return_result = {
				new_attributes: [],
				written_hashes: [10],
				skipped_hashes: [],
				schema_table: {
					attributes: NO_NEW_ATTR_TEST,
					hash_attribute: HASH_ATTRIBUTE_NAME,
					residence: undefined,
					schema: INSERT_OBJECT_TEST.schema,
					name: INSERT_OBJECT_TEST.table,
				},
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

			let expected_search = test_utils.assignObjecttoNullObject(update_obj.records[0]);
			expected_search.__createdtime__ = m_time - 1;
			expected_search.__updatedtime__ = m_time;
			expected_search.height = null;

			let results = await test_utils.assertErrorAsync(lmdb_update_records, [update_obj], undefined);
			assert.deepStrictEqual(results, expected_return_result);

			let dog_env = await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[path.join(BASE_SCHEMA_PATH, INSERT_OBJECT_TEST.schema), INSERT_OBJECT_TEST.table],
				undefined
			);
			let transaction = dog_env.useReadTransaction();
			transaction.database = dog_env;

			let record = test_utils.assertErrorSync(
				search_utility.searchByHash,
				[transaction, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, 10],
				undefined
			);
			assert.deepStrictEqual(record, expected_search);

			//make sure the height index does not have an entry for id 10
			let height_results = test_utils.assertErrorSync(search_utility.iterateDBI, [transaction, 'height'], undefined);
			Object.keys(height_results).forEach((result) => {
				assert(result.indexOf(10) < 0);
			});

			//verify txns with update
			let orig_rec = {
				__createdtime__: TIMESTAMP,
				__updatedtime__: TIMESTAMP,
				age: 5,
				breed: 'Mutt',
				height: 145,
				id: 10,
				name: 'Rob',
			};

			let update_txn = {
				...new LMDBUpdateTransactionObject(update_obj.records, [orig_rec], undefined, m_time, [10]),
			};
			copy_expected_timestamp_txn[m_time] = [update_txn];

			copy_expected_hashes_txn[10].push(m_time);
			await verify_txn(
				TXN_SCHEMA_PATH,
				INSERT_OBJECT_TEST.table,
				copy_expected_timestamp_txn,
				copy_expected_hashes_txn
			);
		});

		it('Test updating 1 row with __clustering__ = true', async () => {
			const update_obj = {
				operation: 'update',
				schema: 'dev',
				table: 'dog',
				__clustering__: true,
				records: [
					{
						name: 'Beethoven',
						breed: 'St. Bernard',
						id: 10,
						height: undefined,
						age: 10,
						__updatedtime__: 9999999999999966,
						__createdtime__: 3333334,
					},
				],
			};

			m_time_stub.restore();
			m_time = TIMESTAMP + 2;
			m_time_stub = sandbox.stub(lmdb_common, 'getNextMonotonicTime').returns(m_time);
			let expected_return_result = {
				new_attributes: [],
				written_hashes: [10],
				skipped_hashes: [],
				schema_table: {
					attributes: NO_NEW_ATTR_TEST,
					hash_attribute: HASH_ATTRIBUTE_NAME,
					residence: undefined,
					schema: INSERT_OBJECT_TEST.schema,
					name: INSERT_OBJECT_TEST.table,
				},
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

			let expected_search = test_utils.assignObjecttoNullObject(update_obj.records[0]);
			expected_search.__createdtime__ = TIMESTAMP;
			expected_search.__updatedtime__ = TIMESTAMP + 2;
			expected_search.height = null;

			let results = await test_utils.assertErrorAsync(lmdb_update_records, [update_obj], undefined);
			assert.deepStrictEqual(results, expected_return_result);

			let dog_env = await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[path.join(BASE_SCHEMA_PATH, INSERT_OBJECT_TEST.schema), INSERT_OBJECT_TEST.table],
				undefined
			);
			let transaction = dog_env.useReadTransaction();
			transaction.database = dog_env;

			let record = test_utils.assertErrorSync(
				search_utility.searchByHash,
				[transaction, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, 10],
				undefined
			);
			assert.deepStrictEqual(record, expected_search);

			//make sure the height index does not have an entry for id 10
			let height_results = test_utils.assertErrorSync(search_utility.iterateDBI, [transaction, 'height'], undefined);
			Object.keys(height_results).forEach((result) => {
				assert(result.indexOf(10) < 0);
			});

			//verify txns with update
			let orig_rec = {
				__createdtime__: TIMESTAMP,
				__updatedtime__: TIMESTAMP,
				age: 5,
				breed: 'Mutt',
				height: 145,
				id: 10,
				name: 'Rob',
			};

			let update_txn = {
				...new LMDBUpdateTransactionObject(update_obj.records, [orig_rec], undefined, m_time, [10]),
			};
			copy_expected_timestamp_txn[m_time] = [update_txn];

			copy_expected_hashes_txn[10].push(m_time);
			await verify_txn(
				TXN_SCHEMA_PATH,
				INSERT_OBJECT_TEST.table,
				copy_expected_timestamp_txn,
				copy_expected_hashes_txn
			);
		});

		it('Test update record with no hash attribute', async () => {
			const update_obj = {
				operation: 'update',
				schema: 'dev',
				table: 'dog',
				records: [
					{
						name: 'Beethoven',
						breed: 'St. Bernard',
						height: undefined,
						age: 10,
					},
				],
			};

			let no_hash_error = new Error(
				'a valid hash attribute must be provided with update record, check log for more info'
			);

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

			let update1 = test_utils.deepClone(update_obj);
			await test_utils.assertErrorAsync(lmdb_update_records, [update1], no_hash_error);

			let update2 = test_utils.deepClone(update_obj);
			update2.id = null;
			await test_utils.assertErrorAsync(lmdb_update_records, [update2], no_hash_error);

			let update3 = test_utils.deepClone(update_obj);
			update3.id = undefined;
			await test_utils.assertErrorAsync(lmdb_update_records, [update3], no_hash_error);

			let update4 = test_utils.deepClone(update_obj);
			update4.id = '';
			await test_utils.assertErrorAsync(lmdb_update_records, [update4], no_hash_error);

			//verify inserted txn
			await verify_txn(
				TXN_SCHEMA_PATH,
				INSERT_OBJECT_TEST.table,
				copy_expected_timestamp_txn,
				copy_expected_hashes_txn
			);
		});

		it('Test updating a row that does not exist', async () => {
			const update_obj = {
				operation: 'update',
				schema: 'dev',
				table: 'dog',
				records: [
					{
						name: 'Beethoven',
						breed: 'St. Bernard',
						height: undefined,
						id: 'faker',
						age: 10,
					},
				],
			};

			let expected_result = {
				written_hashes: [],
				skipped_hashes: ['faker'],
				schema_table: {
					attributes: NO_NEW_ATTR_TEST,
					hash_attribute: 'id',
					residence: undefined,
					schema: update_obj.schema,
					name: update_obj.table,
				},
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

			let results = await test_utils.assertErrorAsync(lmdb_update_records, [update_obj], undefined);
			assert.deepStrictEqual(results.written_hashes, expected_result.written_hashes);
			assert.deepStrictEqual(results.skipped_hashes, expected_result.skipped_hashes);
		});
	});
});
