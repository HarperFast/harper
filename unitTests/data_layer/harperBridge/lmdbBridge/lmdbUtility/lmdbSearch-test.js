'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
const path = require('path');
const SYSTEM_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockLMDBPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, SYSTEM_FOLDER_NAME);
const DEV_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, 'dev');

let test_data = require('../../../../testData');

const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../../../utility/lmdb/writeUtility');
const SearchObject = require('../../../../../data_layer/SearchObject');
const lmdb_search = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbSearch');
const lmdb_terms = require('../../../../../utility/lmdb/terms');
const hdb_terms = require('../../../../../utility/hdbTerms');
const LMDB_ERRORS = require('../../../../commonTestErrors').LMDB_ERRORS_ENUM;
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');
const common_utils = require('../../../../../utility/common_utils');
const common = require('../../../../../utility/lmdb/commonUtility');
const { orderedArray } = test_utils;
const TIMESTAMP = Date.now();

const sandbox = sinon.createSandbox();

const TIMESTAMP_OBJECT = {
	[hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME]: TIMESTAMP,
	[hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME]: TIMESTAMP,
};

const create_search_type_function = lmdb_search.__get__('createSearchTypeFromSearchObject');
const HASH_ATTRIBUTE_NAME = 'id';

describe('test lmdbSearch module', () => {
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

	describe('Test createSearchTypeFromSearchObject method', () => {
		it('test for search all with wildcard search *', () => {
			let search_object = new SearchObject('dev', 'dog', 'name', '*', 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.SEARCH_ALL);
		});

		it('test for search all with wildcard search %', () => {
			let search_object = new SearchObject('dev', 'dog', 'name', '%', 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.SEARCH_ALL);
		});

		it('test for * search on hash attribute is search_all', () => {
			let search_object = new SearchObject('dev', 'dog', 'id', '*', 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.SEARCH_ALL);
		});

		it('test for * search on hash attribute whith return_map = true is search_all map', () => {
			let search_object = new SearchObject('dev', 'dog', 'id', '*', 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id', true], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.SEARCH_ALL_TO_MAP);
		});

		it('test for % search on hash attribute whith return_map = true is search_all map', () => {
			let search_object = new SearchObject('dev', 'dog', 'id', '%', 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id', true], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.SEARCH_ALL_TO_MAP);
		});

		it('test for exact search on hash attribute is batch search by hash', () => {
			let search_object = new SearchObject('dev', 'dog', 'id', 1, 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH);
		});

		it('test for exact search on hash attribute with return_map = true is batch search by hash to map', () => {
			let search_object = new SearchObject('dev', 'dog', 'id', 1, 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id', true], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH_TO_MAP);
		});

		it('test for exact search on attribute is equals', () => {
			let search_object = new SearchObject('dev', 'dog', 'age', 1, 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.EQUALS);
		});

		it('test for * at first and last character is contains', () => {
			let search_object = new SearchObject('dev', 'dog', 'name', '*yl*', 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.CONTAINS);
		});

		it('test for % at first and last character is contains', () => {
			let search_object = new SearchObject('dev', 'dog', 'name', '%yl%', 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.CONTAINS);
		});

		it('test for * or % at first and last character is contains', () => {
			let search_object = new SearchObject('dev', 'dog', 'name', '*yl%', 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.CONTAINS);

			search_object.search_value = '%yl*';
			search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.CONTAINS);
		});

		it('test for * or % at first character only is ends with', () => {
			let search_object = new SearchObject('dev', 'dog', 'name', '*yl', 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.ENDS_WITH);

			search_object.search_value = '%yl';
			search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.ENDS_WITH);
		});

		it('test for * or % at last character only is starts with', () => {
			let search_object = new SearchObject('dev', 'dog', 'name', 'Kyl*', 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.STARTS_WITH);

			search_object.search_value = 'Kyl%';
			search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.STARTS_WITH);
		});

		it('test for wildcard in middle of value is equals', () => {
			let search_object = new SearchObject('dev', 'dog', 'name', 'Ky*le', 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.EQUALS);
		});

		it('test for percent wildcard in middle of value is equals', () => {
			let search_object = new SearchObject('dev', 'd%og', 'name', 'Kyle', 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(create_search_type_function, [search_object, 'id'], undefined);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.EQUALS);
		});

		it('test for > comparator is GREATER_THAN', () => {
			let search_object = new SearchObject('dev', 'dog', 'age', 1, 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(
				create_search_type_function,
				[search_object, 'id', false, hdb_terms.VALUE_SEARCH_COMPARATORS.GREATER],
				undefined
			);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.GREATER_THAN);
		});

		it('test for >= comparator is GREATER_THAN_EQUAL', () => {
			let search_object = new SearchObject('dev', 'dog', 'age', 1, 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(
				create_search_type_function,
				[search_object, 'id', false, hdb_terms.VALUE_SEARCH_COMPARATORS.GREATER_OR_EQ],
				undefined
			);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL);
		});

		it('test for < comparator is LESS_THAN', () => {
			let search_object = new SearchObject('dev', 'dog', 'age', 1, 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(
				create_search_type_function,
				[search_object, 'id', false, hdb_terms.VALUE_SEARCH_COMPARATORS.LESS],
				undefined
			);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.LESS_THAN);
		});

		it('test for <= comparator is LESS_THAN_EQUAL', () => {
			let search_object = new SearchObject('dev', 'dog', 'age', 1, 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(
				create_search_type_function,
				[search_object, 'id', false, hdb_terms.VALUE_SEARCH_COMPARATORS.LESS_OR_EQ],
				undefined
			);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL);
		});

		it('test for ... comparator is BETWEEN', () => {
			let search_object = new SearchObject('dev', 'dog', 'age', 1, 'id', ['id', 'name']);
			let search_type = test_utils.assertErrorSync(
				create_search_type_function,
				[search_object, 'id', false, hdb_terms.VALUE_SEARCH_COMPARATORS.BETWEEN],
				undefined
			);
			assert.deepStrictEqual(search_type, lmdb_terms.SEARCH_TYPES.BETWEEN);
		});
	});

	describe('test executeSearch method', () => {
		let env;
		before(async () => {
			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
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
			await environment_utility.createDBI(env, 'id', false);
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
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('test equals on string', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.state === 'CO') {
					expected.push(test_utils.assignObjecttoNullObject(data));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ['*']);
			let results = Array.from(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test equals on string return pairs', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.state === 'CO') {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ['*']);
			let results = Array.from(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test equals on number', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (parseInt(data.temperature) === 10) {
					expected.push(test_utils.assignObjecttoNullObject(data));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 10, 'id', ['*']);
			let results = Array.from(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test equals on number return pairs', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (parseInt(data.temperature) === 10) {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 10, 'id', ['*']);
			let results = Array.from(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test equals on hash attribute', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (parseInt(data.id) === 10) {
					expected.push(test_utils.assignObjecttoNullObject(data));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'id', 10, 'id', ['*']);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test  equals on hash attribute return pairs', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (parseInt(data.id) === 10) {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'id', 10, 'id', ['*']);
			let results = Array.from(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH_TO_MAP, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test contains on string', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.city.includes('bert') === true) {
					expected.push(test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ['*']);
			let results = Array.from(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test  contains on string return pairs', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.city.includes('bert') === true) {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test contains on number', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature.toString().includes(0)) {
					expected.push(test_utils.assignObjecttoNullObject(data));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 0, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test  contains on number return pairs', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature.toString().includes(0)) {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 0, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test endswith on string', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.city.endsWith('land')) {
					expected.push(test_utils.assignObjecttoNullObject(data));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'city', 'land', 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test  endswith on string return pairs', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.city.endsWith('land')) {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'city', 'land', 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test endswith on number', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature.toString().endsWith(2)) {
					expected.push(test_utils.assignObjecttoNullObject(data));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 2, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test endswith on number return pairs', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature.toString().endsWith(2)) {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 2, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test startswith on string', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.city.startsWith('South')) {
					expected.push(test_utils.assignObjecttoNullObject(data));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'city', 'South', 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test startswith on string return pairs', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.city.startsWith('South')) {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'city', 'South', 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test startswith on number', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature.toString().startsWith(10)) {
					expected.push(test_utils.assignObjecttoNullObject(data));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 10, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test startswith on number return pairs', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature.toString().startsWith(10)) {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 10, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test searchall', async () => {
			let expected = [];
			test_data.forEach((data) => {
				expected.push(test_utils.assignObjecttoNullObject(data));
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', '*', 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.SEARCH_ALL, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test searchall to map', async () => {
			let expected = [];
			test_data.forEach((data) => {
				expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', '10%', 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.SEARCH_ALL_TO_MAP, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test greaterthan', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature > 25) {
					expected.push(test_utils.assignObjecttoNullObject(data));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 25, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test greaterthan to map', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature > 25) {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 25, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test greaterthanequal', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature >= 40) {
					expected.push(test_utils.assignObjecttoNullObject(data));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 40, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test greaterthanequal to map', async () => {
			let expected = [];
			test_data.forEach((data) => {
				// eslint-disable-next-line no-magic-numbers
				if (data.temperature >= 40) {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 40, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test lessthan', async () => {
			let expected = [];
			test_data.forEach((data) => {
				// eslint-disable-next-line no-magic-numbers
				if (data.temperature < 25) {
					expected.push(test_utils.assignObjecttoNullObject(data));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 25, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test lessthan to map', async () => {
			let expected = [];
			test_data.forEach((data) => {
				// eslint-disable-next-line no-magic-numbers
				if (data.temperature < 25) {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 25, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test lessthanequal', async () => {
			let expected = [];
			test_data.forEach((data) => {
				// eslint-disable-next-line no-magic-numbers
				if (data.temperature <= 40) {
					expected.push(test_utils.assignObjecttoNullObject(data));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 40, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test lessthanequal to map', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature <= 40) {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 40, 'id', ['*']);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});

		it('test between', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature >= 40 && data.temperature <= 66) {
					expected.push(test_utils.assignObjecttoNullObject(data));
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 40, 'id', ['*'], 66);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.BETWEEN, HASH_ATTRIBUTE_NAME],
					undefined
				)
			);
			assert.deepEqual(results.length, expected.length);

			results.forEach((result) => {
				expected.forEach((expect) => {
					if (result.id === expect.id) {
						assert.deepStrictEqual(result, expect);
					}
				});
			});
		});

		it('test between to map', async () => {
			let expected = [];
			test_data.forEach((data) => {
				if (data.temperature >= 40 && data.temperature <= 66) {
					expected.push([data.id, test_utils.assignObjecttoNullObject(data, TIMESTAMP_OBJECT)]);
				}
			});

			let search_object = new SearchObject('dev', 'test', 'temperature', 40, 'id', ['*'], 66);
			let results = orderedArray(
				await test_utils.assertErrorAsync(
					lmdb_search.executeSearch,
					[search_object, lmdb_terms.SEARCH_TYPES.BETWEEN, HASH_ATTRIBUTE_NAME, true],
					undefined
				)
			);
			assert(Object.keys(results).length > 0);
			assert.deepStrictEqual(results, expected);
		});
	});
});
