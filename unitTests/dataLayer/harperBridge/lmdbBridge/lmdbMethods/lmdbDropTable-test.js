'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
const path = require('path');
const SYSTEM_FOLDER_NAME = 'system';
const BASE_PATH = test_utils.getMockLMDBPath();
const SYSTEM_SCHEMA_PATH = path.join(BASE_PATH, SYSTEM_FOLDER_NAME);
const DEV_SCHEMA_PATH = path.join(BASE_PATH, 'dev');
const TRANSACTIONS_NAME = 'transactions';
const BASE_TXN_PATH = path.join(BASE_PATH, TRANSACTIONS_NAME);

let test_data = require('../../../../testData');

const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const SearchObject = require('../../../../../dataLayer/SearchObject');
const SearchByHashObject = require('../../../../../dataLayer/SearchByHashObject');
const DropAttributeObject = require('../../../../../dataLayer/DropAttributeObject');
const lmdb_drop_table = rewire('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbDropTable');
const search_by_value = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbSearchByValue');
const search_by_hash = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbSearchByHash');
const lmdb_create_schema = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
const lmdb_create_records = require('../../../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateRecords');
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');

const TIMESTAMP = Date.now();

const sandbox = sinon.createSandbox();

const drop_table_from_system = lmdb_drop_table.__get__('dropTableFromSystem');

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

const INSERT_OBJECT_TEST = {
	operation: 'insert',
	schema: 'dev',
	table: 'test',
	records: test_data,
};

describe('test lmdbDropTable module', () => {
	let date_stub;
	before(async () => {
		await fs.remove(test_utils.getMockLMDBPath());
		date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
	});

	after(() => {
		date_stub.restore();
	});

	describe('test dropTableFromSystem method', () => {
		let hdb_schema_env;
		let hdb_table_env;
		let hdb_attribute_env;
		before(async () => {
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
				},
				system: systemSchema,
			};

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
			global.hdb_schema.dev.test.attributes = [
				{ attribute: 'id' },
				{ attribute: '__updatedtime__' },
				{ attribute: '__createdtime__' },
			];

			await lmdb_create_records(INSERT_OBJECT_TEST);

			global.hdb_schema.dev.test.attributes = [
				{ attribute: 'id' },
				{ attribute: 'temperature' },
				{ attribute: 'temperature_str' },
				{ attribute: 'city' },
				{ attribute: 'state' },
				{ attribute: '__updatedtime__' },
				{ attribute: '__createdtime__' },
			];
		});

		after(async () => {
			let env2 = await environment_utility.openEnvironment(
				path.join(BASE_PATH, CREATE_TABLE_OBJ_TEST_A.schema),
				CREATE_TABLE_OBJ_TEST_A.table
			);
			await env2.close();

			let txn_env1 = await environment_utility.openEnvironment(
				path.join(BASE_TXN_PATH, CREATE_TABLE_OBJ_TEST_A.schema),
				CREATE_TABLE_OBJ_TEST_A.table,
				true
			);
			await txn_env1.close();

			await hdb_attribute_env.close();
			await hdb_schema_env.close();
			await hdb_table_env.close();

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('test invalid schema', async () => {
			let drop_object = new DropAttributeObject('faker', 'test');
			await test_utils.assertErrorAsync(
				drop_table_from_system,
				[drop_object],
				new Error(`${drop_object.schema}.${drop_object.table} was not found`)
			);
		});

		it('test invalid table', async () => {
			let drop_object = new DropAttributeObject('dev', 'fake');
			await test_utils.assertErrorAsync(
				drop_table_from_system,
				[drop_object],
				new Error(`${drop_object.schema}.${drop_object.table} was not found`)
			);
		});

		it('test delete table metadata', async () => {
			let search_obj = new SearchObject('system', 'hdb_table', 'name', 'test', undefined, ['*']);
			let search_table_results = Array.from(await search_by_value(search_obj));
			let found_tbl;
			for (let x = 0; x < search_table_results.length; x++) {
				if (search_table_results[x].schema === 'dev' && search_table_results[x].name === 'test') {
					found_tbl = search_table_results[x];
				}
			}
			assert.deepStrictEqual(`${found_tbl.schema}.${found_tbl.name}`, 'dev.test');

			let drop_object = new DropAttributeObject('dev', 'test');
			await test_utils.assertErrorAsync(drop_table_from_system, [drop_object], undefined);

			search_table_results = Array.from(await search_by_value(search_obj));
			found_tbl = undefined;
			for (let x = 0; x < search_table_results.length; x++) {
				if (search_table_results[x].schema === 'dev' && search_table_results[x].name === 'test') {
					found_tbl = search_table_results[x];
				}
			}

			assert.deepStrictEqual(found_tbl, undefined);
		});
	});

	describe('test lmdbDropTable method', () => {
		let hdb_schema_env;
		let hdb_table_env;
		let hdb_attribute_env;
		before(async () => {
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
				},
				system: systemSchema,
			};

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
			global.hdb_schema.dev.test.attributes = [
				{ attribute: 'id' },
				{ attribute: '__updatedtime__' },
				{ attribute: '__createdtime__' },
			];
			await lmdb_create_records(INSERT_OBJECT_TEST);
			global.hdb_schema.dev.test.attributes = [
				{ attribute: 'id' },
				{ attribute: 'temperature' },
				{ attribute: 'temperature_double' },
				{ attribute: 'temperature_pos' },
				{ attribute: 'temperature_neg' },
				{ attribute: 'temperature_str' },
				{ attribute: 'city' },
				{ attribute: 'state' },
				{ attribute: '__updatedtime__' },
				{ attribute: '__createdtime__' },
			];
		});

		after(async () => {
			await hdb_attribute_env.close();
			await hdb_schema_env.close();
			await hdb_table_env.close();

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('test invalid schema', async () => {
			let drop_object = new DropAttributeObject('faker', 'test');
			await test_utils.assertErrorAsync(
				lmdb_drop_table,
				[drop_object],
				new Error(`unknown schema:faker and table test`)
			);
		});

		it('test invalid table', async () => {
			let drop_object = new DropAttributeObject('dev', 'fake');
			await test_utils.assertErrorAsync(lmdb_drop_table, [drop_object], new Error(`unknown schema:dev and table fake`));
		});

		it('test delete table', async () => {
			let search_obj = new SearchObject('system', 'hdb_table', 'name', 'test', undefined, ['*']);
			let search_table_results = Array.from(await search_by_value(search_obj));
			let found_tbl;
			for (let x = 0; x < search_table_results.length; x++) {
				if (search_table_results[x].schema === 'dev' && search_table_results[x].name === 'test') {
					found_tbl = search_table_results[x];
				}
			}
			assert.deepStrictEqual(`${found_tbl.schema}.${found_tbl.name}`, 'dev.test');

			let search_attr_obj = new SearchObject('system', 'hdb_attribute', 'schema_table', 'dev.test', undefined, [
				'attribute',
			]);
			let search_attr_results = Array.from(await search_by_value(search_attr_obj));
			assert.deepStrictEqual(search_attr_results.length, global.hdb_schema.dev.test.attributes.length);

			for (let x = 0; x < search_attr_results.length; x++) {
				let actual = search_attr_results[x];
				let expected;
				global.hdb_schema.dev.test.attributes.forEach((attr) => {
					if (actual.attribute === attr.attribute) {
						expected = attr;
					}
				});
				assert.deepEqual(actual, expected);
			}

			await test_utils.assertErrorAsync(fs.access, [path.join(DEV_SCHEMA_PATH, 'test.mdb')], undefined);

			//validate the transactions environments
			let transaction_path = path.join(BASE_PATH, 'transactions', 'dev');
			let table_transaction_path = path.join(transaction_path, 'test.mdb');
			let expected_txn_dbis = ['hash_value', 'timestamp', 'user_name'];
			await test_utils.assertErrorAsync(fs.access, [table_transaction_path], undefined);
			let txn_env = await test_utils.assertErrorAsync(
				environment_utility.openEnvironment,
				[transaction_path, 'test', true],
				undefined
			);
			let txn_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [txn_env], undefined);

			assert.deepStrictEqual(txn_dbis, expected_txn_dbis);

			let drop_object = new DropAttributeObject('dev', 'test');
			await test_utils.assertErrorAsync(lmdb_drop_table, [drop_object], undefined);

			search_table_results = Array.from(await search_by_value(search_obj));
			found_tbl = undefined;
			for (let x = 0; x < search_table_results.length; x++) {
				if (search_table_results[x].schema === 'dev' && search_table_results[x].name === 'test') {
					found_tbl = search_table_results[x];
				}
			}

			assert.deepStrictEqual(found_tbl, undefined);

			//search for the table by id
			let hash_search = new SearchByHashObject('system', 'hdb_attribute', [TABLE_SYSTEM_DATA_TEST_A.id], ['*']);
			search_table_results = Array.from(await search_by_hash(hash_search));
			assert.deepStrictEqual(search_table_results, []);

			search_attr_obj = new SearchObject('system', 'hdb_attribute', 'schema_table', 'dev.test', undefined, [
				'attribute',
			]);
			search_attr_results = Array.from(await search_by_value(search_attr_obj));
			assert.deepStrictEqual(search_attr_results, []);

			let error = undefined;
			try {
				await fs.access(path.join(DEV_SCHEMA_PATH, 'test')).catch((e) => {
					error = e;
				});
			} catch (e) {
				error = e;
			}

			assert(error.message.startsWith('ENOENT: no such file or directory'));

			//verify transaction environment is deleted
			error = undefined;
			try {
				await fs.access(table_transaction_path).catch((e) => {
					error = e;
				});
			} catch (e) {
				error = e;
			}

			assert(error.message.startsWith('ENOENT: no such file or directory'));
		});
	});
});

describe('test deleteAttributesFromSystem function', () => {
	let hdb_schema_env;
	let hdb_table_env;
	let hdb_attribute_env;
	let delete_attributes_from_system;
	before(async () => {
		delete_attributes_from_system = lmdb_drop_table.__get__('deleteAttributesFromSystem');

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
			{ attribute: '__blob__' },
		];

		await lmdb_create_records(INSERT_OBJECT_TEST);

		global.hdb_schema.dev.test.attributes = [
			{ attribute: 'id' },
			{ attribute: 'temperature' },
			{ attribute: 'temperature_double' },
			{ attribute: 'temperature_pos' },
			{ attribute: 'temperature_neg' },
			{ attribute: 'temperature_str' },
			{ attribute: 'city' },
			{ attribute: 'state' },
			{ attribute: '__updatedtime__' },
			{ attribute: '__createdtime__' },
			{ attribute: '__blob__' },
		];
	});

	after(async () => {
		let env = await environment_utility.openEnvironment(
			path.join(BASE_PATH, CREATE_TABLE_OBJ_TEST_A.schema),
			CREATE_TABLE_OBJ_TEST_A.table
		);
		env.close();

		let txn_env1 = await environment_utility.openEnvironment(
			path.join(BASE_TXN_PATH, CREATE_TABLE_OBJ_TEST_A.schema),
			CREATE_TABLE_OBJ_TEST_A.table,
			true
		);
		txn_env1.close();

		hdb_schema_env.close();
		hdb_table_env.close();
		hdb_attribute_env.close();

		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
	});

	it('test removing all attributes', async () => {
		sandbox.restore();
		let search_by_value_spy = sandbox.spy(lmdb_drop_table.__get__('searchByValue'));
		let delete_records_spy = sandbox.spy(lmdb_drop_table.__get__('deleteRecords'));

		let search_obj = new SearchObject('system', 'hdb_attribute', 'schema_table', 'dev.test', undefined, ['*']);
		let results = await test_utils.assertErrorAsync(search_by_value, [search_obj], undefined);
		assert.notDeepStrictEqual(results.length, 0);

		let drop_obj = {
			schema: 'dev',
			table: 'test',
		};
		await test_utils.assertErrorAsync(delete_attributes_from_system, [drop_obj], undefined);
		let new_results = Array.from(await test_utils.assertErrorAsync(search_by_value, [search_obj], undefined));
		assert.deepStrictEqual(new_results.length, 0);
	});
});
