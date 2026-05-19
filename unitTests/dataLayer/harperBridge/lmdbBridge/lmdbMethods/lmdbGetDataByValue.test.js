'use strict';

const testUtils = require('../../../../testUtils');
testUtils.preTestPrep();
const path = require('path');
const SYSTEM_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = testUtils.setupTestDBPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, SYSTEM_FOLDER_NAME);
const DEV_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, 'dev');
const { orderedArray } = testUtils;
const test_data = require('../../../../testData');

const rewire = require('rewire');
const environment_utility = rewire('#src/utility/lmdb/environmentUtility');
const write_utility = require('#src/utility/lmdb/writeUtility');
const SearchObject = require('#src/dataLayer/SearchObject');
const lmdb_search = rewire('#js/dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbGetDataByValue');
const common_utils = require('#src/utility/common_utils');
const hdb_terms = require('#src/utility/hdbTerms');
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');
const common = require('#src/utility/lmdb/commonUtility');

const TIMESTAMP = Date.now();

const sandbox = sinon.createSandbox();

const TIMESTAMP_OBJECT = {
	[hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME]: TIMESTAMP,
	[hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME]: TIMESTAMP,
};

describe('test lmdbGetDataByValue module', () => {
	let date_stub;
	before(() => {
		test_data.forEach((record) => {
			Object.keys(record).forEach((key) => {
				record[key] = common_utils.autoCast(record[key]);
			});
		});

		date_stub = sandbox.stub(common, 'getNextMonotonicTime').returns(TIMESTAMP);
	});

	after(() => {
		date_stub.restore();
	});

	describe('test method', () => {
		let env;
		before(async () => {
			global.lmdb_map = undefined;
			await fs.remove(testUtils.setupTestDBPath());
			await fs.mkdirp(SYSTEM_SCHEMA_PATH);
			await fs.mkdirp(DEV_SCHEMA_PATH);

			global.hdb_schema = {
				dev: {
					test: {
						attributes: [
							{ attribute: 'id' },
							{ attribute: 'temperature' },
							{ attribute: 'temperature_str' },
							{ attribute: 'state' },
							{ attribute: 'city' },
						],
						hash_attribute: 'id',
						schema: 'dev',
						name: 'test',
					},
				},
				system: systemSchema,
			};

			env = await environment_utility.createEnvironment(DEV_SCHEMA_PATH, 'test');
			await environment_utility.createDBI(env, 'id', false, true);
			await environment_utility.createDBI(env, 'temperature', true);
			await environment_utility.createDBI(env, 'temperature_double', true);
			await environment_utility.createDBI(env, 'temperature_neg', true);
			await environment_utility.createDBI(env, 'temperature_pos', true);
			await environment_utility.createDBI(env, 'temperature_str', true);
			await environment_utility.createDBI(env, 'state', true);
			await environment_utility.createDBI(env, 'city', true);

			await write_utility.insertRecords(
				env,
				'id',
				['id', 'temperature', 'temperature_str', 'state', 'city'],
				test_data
			);
		});

		after(async () => {
			await env.close();

			global.lmdb_map = undefined;
			await fs.remove(testUtils.setupTestDBPath());
		});

		it('test validation', async () => {
			await testUtils.assertErrorAsync(
				lmdb_search,
				[{}],
				new Error(
					"'schema' is required. 'table' is required. 'search_attribute' is required. 'search_value' is required. 'get_attributes' is required"
				)
			);
			await testUtils.assertErrorAsync(
				lmdb_search,
				[{ schema: 'dev' }],
				new Error(
					"'table' is required. 'search_attribute' is required. 'search_value' is required. 'get_attributes' is required"
				)
			);
			await testUtils.assertErrorAsync(
				lmdb_search,
				[{ schema: 'dev', table: 'test' }],
				new Error("'search_attribute' is required. 'search_value' is required. 'get_attributes' is required")
			);
			await testUtils.assertErrorAsync(
				lmdb_search,
				[{ schema: 'dev', table: 'test', search_attribute: 'city' }],
				new Error("'search_value' is required. 'get_attributes' is required")
			);
			await testUtils.assertErrorAsync(
				lmdb_search,
				[{ schema: 'dev', table: 'test', search_attribute: 'city', search_value: '*' }],
				new Error("'get_attributes' is required")
			);
			await testUtils.assertErrorAsync(
				lmdb_search,
				[{ schema: 'dev/sss', table: 'test', search_attribute: 'city', search_value: '*', get_attributes: ['*'] }],
				new Error("'schema' names cannot include backticks or forward slashes")
			);
			await testUtils.assertErrorAsync(
				lmdb_search,
				[{ schema: 'dev', table: 'test`er`', search_attribute: 'city', search_value: '*', get_attributes: ['*'] }],
				new Error("'table' names cannot include backticks or forward slashes")
			);

			await testUtils.assertErrorAsync(
				lmdb_search,
				[{ schema: 'dev', table: 'test', search_attribute: 'city', search_value: '*', get_attributes: ['*'] }, '$$'],
				new Error('Value search comparator - $$ - is not valid')
			);
		});

		it('test schema validation', async () => {
			testUtils.assertErrorAsync(
				lmdb_search,
				[
					{
						schema: 'dev2',
						table: 'test',
						search_attribute: 'city',
						search_value: '*',
						get_attributes: ['*'],
					},
				],
				testUtils.generateHDBError("Schema 'dev2' does not exist", 404)
			);
			testUtils.assertErrorAsync(
				lmdb_search,
				[
					{
						schema: 'dev',
						table: 'fake',
						search_attribute: 'city',
						search_value: '*',
						get_attributes: ['*'],
					},
				],
				testUtils.generateHDBError("Table 'dev.fake' does not exist", 404)
			);
			await testUtils.assertErrorAsync(
				lmdb_search,
				[{ schema: 'dev', table: 'test', search_attribute: 'fake_city', search_value: '*', get_attributes: ['*'] }],
				new Error("unknown attribute 'fake_city'")
			);
			await testUtils.assertErrorAsync(
				lmdb_search,
				[{ schema: 'dev', table: 'test', search_attribute: 'city', search_value: '*', get_attributes: ['id', 'fake'] }],
				new Error("unknown attribute 'fake'")
			);
		});

		it('test equals on string', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.state === 'CO') {
					expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ['*']);
			let results = orderedArray(await testUtils.assertErrorAsync(lmdb_search, [search_object], undefined));
			assert.deepStrictEqual(results, expected);
		});

		it('test equals on number', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (parseInt(data.temperature) === 10) {
					expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 10, 'id', ['*']);
			let results = orderedArray(await testUtils.assertErrorAsync(lmdb_search, [search_object], undefined));
			assert.deepStrictEqual(results, expected);
		});

		it('test equals on hash attribute', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (parseInt(data.id) === 10) {
					expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'id', 10, 'id', ['*']);
			let results = orderedArray(await testUtils.assertErrorAsync(lmdb_search, [search_object], undefined));
			assert.deepStrictEqual(results, expected);
		});

		it('test contains on string', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.city.includes('bert') === true) {
					expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'city', '*bert*', 'id', ['*']);
			let results = orderedArray(await testUtils.assertErrorAsync(lmdb_search, [search_object], undefined));
			assert.deepStrictEqual(results, expected);
		});

		it('test contains on number', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature.toString().includes(0)) {
					expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', '*0*', 'id', ['*']);
			let results = orderedArray(await testUtils.assertErrorAsync(lmdb_search, [search_object], undefined));
			assert.deepStrictEqual(results, expected);
		});

		it('test endswith on string', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.city.endsWith('land')) {
					expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'city', '*land', 'id', ['*']);
			let results = orderedArray(await testUtils.assertErrorAsync(lmdb_search, [search_object], undefined));
			assert.deepStrictEqual(results, expected);
		});

		it('test endswith on number', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature.toString().endsWith(2)) {
					expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', '%2', 'id', ['*']);
			let results = orderedArray(await testUtils.assertErrorAsync(lmdb_search, [search_object], undefined));
			assert.deepStrictEqual(results, expected);
		});

		it('test startswith on string', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.city.startsWith('South')) {
					expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'city', 'South*', 'id', ['*']);
			let results = orderedArray(await testUtils.assertErrorAsync(lmdb_search, [search_object], undefined));
			assert.deepStrictEqual(results, expected);
		});

		it('test searchall', async () => {
			let expected = [];
			test_data.forEach((data) => {
				expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', '*', 'id', ['*']);
			let results = orderedArray(await testUtils.assertErrorAsync(lmdb_search, [search_object], undefined));
			assert.deepStrictEqual(results, expected);
		});

		it('test greaterthan', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature > 25) {
					expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 25, 'id', ['*']);
			let results = orderedArray(
				await testUtils.assertErrorAsync(
					lmdb_search,
					[search_object, hdb_terms.VALUE_SEARCH_COMPARATORS.GREATER],
					undefined
				)
			);
			assert.deepStrictEqual(results, expected);
		});

		it('test greaterthanequal', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature >= 40) {
					expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 40, 'id', ['*']);
			let results = orderedArray(
				await testUtils.assertErrorAsync(
					lmdb_search,
					[search_object, hdb_terms.VALUE_SEARCH_COMPARATORS.GREATER_OR_EQ],
					undefined
				)
			);
			assert.deepStrictEqual(results, expected);
		});

		it('test lessthan', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature < 25) {
					expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 25, 'id', ['*']);
			let results = orderedArray(
				await testUtils.assertErrorAsync(
					lmdb_search,
					[search_object, hdb_terms.VALUE_SEARCH_COMPARATORS.LESS],
					undefined
				)
			);
			assert.deepStrictEqual(results, expected);
		});

		it('test lessthanequal', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature <= 40) {
					expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 40, 'id', ['*']);
			let results = orderedArray(
				await testUtils.assertErrorAsync(
					lmdb_search,
					[search_object, hdb_terms.VALUE_SEARCH_COMPARATORS.LESS_OR_EQ],
					undefined
				)
			);
			assert.deepStrictEqual(results, expected);
		});

		it('test between', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature >= 40 && data.temperature <= 66) {
					expected.push([data.id, testUtils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 40, 'id', ['*'], 66);
			let results = orderedArray(
				await testUtils.assertErrorAsync(
					lmdb_search,
					[search_object, hdb_terms.VALUE_SEARCH_COMPARATORS.BETWEEN],
					undefined
				)
			);
			assert.deepStrictEqual(results, expected);
		});
	});
});
