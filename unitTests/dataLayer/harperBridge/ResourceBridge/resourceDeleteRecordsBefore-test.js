'use strict';

const test_utils = require('../../../test_utils');
test_utils.preTestPrep();
const path = require('path');

const SYSTEM_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockLMDBPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const BASE_TXN_PATH = path.join(BASE_PATH, 'transactions');
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, SYSTEM_FOLDER_NAME);
const DEV_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, 'dev');

let test_data = require('../../../testData');

const rewire = require('rewire');
const environment_utility = rewire('../../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../../utility/lmdb/writeUtility');
const SearchObject = require('../../../../dataLayer/SearchObject');
const harper_bridge = require('../../../../dataLayer/harperBridge/harperBridge');
const { createTable, createSchema, createRecords, searchByValue, dropTable } = harper_bridge;
const hdb_terms = require('../../../../utility/hdbTerms');
const assert = require('assert');
const fs = require('fs-extra');
const systemSchema = require('../../../../json/systemSchema');
const ReadAuditLogObject = require('../../../../dataLayer/ReadAuditLogObject');
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

describe('Test ResourceBridge deleteRecordsBefore', () => {
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
			//this.timeout(20000);

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

			await createSchema(CREATE_SCHEMA_DEV);

			await createTable(TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A);
			global.hdb_schema.dev.test.attributes = [
				{ attribute: 'id' },
				{ attribute: '__updatedtime__' },
				{ attribute: '__createdtime__' },
			];

			for (let x = 0; x < 10; x++) {
				await sleep(10);
				let start = x * 100;
				let object_chunk = test_data.slice(start, start + 100);
				INSERT_OBJECT_TEST.records = object_chunk;

				await createRecords(INSERT_OBJECT_TEST);
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

			await createTable(TABLE_SYSTEM_DATA_TEST_B, CREATE_TABLE_OBJ_TEST_B);
			global.hdb_schema.dev.test2.attributes = [
				{ attribute: 'id' },
				{ attribute: '__updatedtime__' },
				{ attribute: '__createdtime__' },
			];
		});

		after(async () => {
			await hdb_table_env.close();
			await hdb_schema_env.close();
			await hdb_attribute_env.close();

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('Test delete where table has no records', async () => {
			let delete_before = { schema: 'dev', table: 'test2', date: new Date(timestamps[0]) };
			let results = await test_utils.assertErrorAsync(harper_bridge.deleteRecordsBefore, [delete_before], undefined);
			assert.deepStrictEqual(results.message, 'No records found to delete');
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
			const results = await harper_bridge.deleteRecordsBefore(delete_before);
			assert.deepStrictEqual(results.message, expected.message);
			assert.deepStrictEqual(results.deleted_hashes.sort(), expected.deleted_hashes.sort());

			let search_obj = new SearchObject('dev', 'test', '__createdtime__', timestamps[0], undefined, ['id']);
			let search_result = Array.from(await searchByValue(search_obj, hdb_terms.VALUE_SEARCH_COMPARATORS.LESS));
			assert.deepStrictEqual(search_result, []);

			search_obj = new SearchObject('dev', 'test', '__createdtime__', timestamps[2], undefined, ['id']);
			search_result = Array.from(await searchByValue(search_obj, hdb_terms.VALUE_SEARCH_COMPARATORS.LESS));
			assert.deepStrictEqual(search_result.length, 200);

			// //test no delete entry in txn log
			// let txn_results = Array.from(await lmdb_read_audit_log(new ReadAuditLogObject('dev', 'test')));
			// for (let x = 0, length = txn_results.length; x < length; x++) {
			// 	assert(txn_results[x].operation !== 'delete');
			// }
		});

		it('Test error is thrown ', async () => {
			await createTable(
				{
					name: 'test-2',
					schema: 'dev',
					id: '25361aa9',
					hash_attribute: 'id',
				},
				{
					operation: 'create_table',
					schema: 'dev',
					table: 'tests-2',
					hash_attribute: 'id',
					attributes: [{ name: 'myCreatedTime', indexed: true }],
				}
			);
			let error;
			try {
				await harper_bridge.deleteRecordsBefore({
					schema: 'dev',
					table: 'tests-2',
					date: new Date(timestamps[0]).toISOString(),
				});
			} catch (err) {
				error = err;
			}

			assert.equal(
				error.message,
				"Table must have a '__createdtime__' attribute or @creationDate timestamp defined to perform this operation"
			);

			dropTable({
				operation: 'drop_table',
				schema: 'dev',
				table: 'test',
				hash_attribute: 'id',
			});
		});

		it('Test custom created time used', async () => {
			await createTable(
				{
					name: 'test-2',
					schema: 'dev',
					id: '25361aa9',
					hash_attribute: 'id',
				},
				{
					operation: 'create_table',
					schema: 'dev',
					table: 'tests-2',
					hash_attribute: 'id',
					attributes: [
						{ name: 'myCreatedTime', assignCreatedTime: true, indexed: true },
						{ name: 'id', indexed: true },
					],
				}
			);

			await createRecords({
				operation: 'insert',
				schema: 'dev',
				table: 'tests-2',
				records: [
					{
						id: 'Leonardo',
					},
					{
						id: 'Donatello',
					},
					{
						id: 'Raphael',
					},
				],
			});

			const result = await harper_bridge.deleteRecordsBefore({
				schema: 'dev',
				table: 'tests-2',
				date: new Date(2186085457061).toISOString(),
			});

			assert.deepStrictEqual(result.message, '3 of 3 records successfully deleted');

			dropTable({
				operation: 'drop_table',
				schema: 'dev',
				table: 'test',
				hash_attribute: 'id',
			});
		});
	});
});
