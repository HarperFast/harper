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

const TIMESTAMP = Date.now();

const sandbox = sinon.createSandbox();

const TIMESTAMP_OBJECT = {
	[hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME]: TIMESTAMP,
	[hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME]: TIMESTAMP,
};

const HASH_ATTRIBUTE_NAME = 'id';
const thread_search_function = lmdb_search.__get__('threadSearch');

const ATTRIBUTES = ['id', 'temperature', 'temperature_str', 'state', 'city'];

describe('test lmdbSearch module', () => {
	let date_stub;
	before(() => {
		test_data.forEach((record) => {
			Object.keys(record).forEach((key) => {
				record[key] = common_utils.autoCast(record[key]);
			});
		});
		date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
	});

	after(() => {
		date_stub.restore();
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
			await environment_utility.createDBI(env, 'id', false, true);
			await environment_utility.createDBI(env, 'temperature', true);
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

		it('test equals on string limit 20', async () => {
			let expected = [
				{ id: 7, temperature: -3, temperature_str: -3, state: 'CO', city: 'Quitzonside' },
				{ id: 23, temperature: 61, temperature_str: 61, state: 'CO', city: 'Kaitlynfort' },
				{ id: 84, temperature: -6, temperature_str: -6, state: 'CO', city: 'West Yvonneberg' },
				{ id: 93, temperature: 107, temperature_str: 107, state: 'CO', city: 'Jackyland' },
				{ id: 122, temperature: 24, temperature_str: 24, state: 'CO', city: 'Adelberthaven' },
				{ id: 134, temperature: 24, temperature_str: 24, state: 'CO', city: 'Gilbertstad' },
				{ id: 144, temperature: 84, temperature_str: 84, state: 'CO', city: 'McGlynnbury' },
				{ id: 217, temperature: 91, temperature_str: 91, state: 'CO', city: 'Chelseyfurt' },
				{ id: 294, temperature: 78, temperature_str: 78, state: 'CO', city: 'Thomasshire' },
				{ id: 375, temperature: 73, temperature_str: 73, state: 'CO', city: 'Wolfbury' },
				{ id: 382, temperature: 46, temperature_str: 46, state: 'CO', city: 'South Katrina' },
				{ id: 512, temperature: 78, temperature_str: 78, state: 'CO', city: 'Curtiston' },
				{ id: 537, temperature: 32, temperature_str: 32, state: 'CO', city: 'North Danaview' },
				{ id: 572, temperature: 3, temperature_str: 3, state: 'CO', city: 'East Cesarfort' },
				{ id: 622, temperature: 27, temperature_str: 27, state: 'CO', city: 'Kalimouth' },
				{ id: 682, temperature: 24, temperature_str: 24, state: 'CO', city: 'Lake Webster' },
				{ id: 698, temperature: 98, temperature_str: 98, state: 'CO', city: 'Lake Cassidy' },
				{ id: 781, temperature: 103, temperature_str: 103, state: 'CO', city: 'Port Brooke' },
				{ id: 809, temperature: 51, temperature_str: 51, state: 'CO', city: 'Lake Chanceton' },
				{ id: 855, temperature: 1, temperature_str: 1, state: 'CO', city: 'Hannahborough' },
			];

			let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ATTRIBUTES, undefined, false, 20);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepStrictEqual(results.length, 20);
			assert.deepEqual(results, expected);
		});

		it('test equals on string limit 20 offset 20', async () => {
			let expected = [
				{ id: 929, temperature: 105, temperature_str: 105, state: 'CO', city: 'Lake Athena' },
				{ id: 964, temperature: 9, temperature_str: 9, state: 'CO', city: 'Meredithshire' },
				{ id: 998, temperature: -9, temperature_str: -9, state: 'CO', city: 'North Sally' },
			];

			let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ATTRIBUTES, undefined, false, 20, 20);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepStrictEqual(results.length, 3);
			assert.deepEqual(results, expected);
		});

		it('test equals on string reverse limit 20 offset 20', async () => {
			let expected = [
				{ id: 7, temperature: -3, temperature_str: -3, state: 'CO', city: 'Quitzonside' },
				{ id: 23, temperature: 61, temperature_str: 61, state: 'CO', city: 'Kaitlynfort' },
				{ id: 84, temperature: -6, temperature_str: -6, state: 'CO', city: 'West Yvonneberg' },
			];

			let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ATTRIBUTES, undefined, true, 20, 20);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepStrictEqual(results.length, 3);
			assert.deepEqual(results, expected);
		});

		it('test equals on string return map limit 20', async () => {
			let expected = {
				7: { id: 7, temperature: -3, temperature_str: -3, state: 'CO', city: 'Quitzonside' },
				23: { id: 23, temperature: 61, temperature_str: 61, state: 'CO', city: 'Kaitlynfort' },
				84: { id: 84, temperature: -6, temperature_str: -6, state: 'CO', city: 'West Yvonneberg' },
				93: { id: 93, temperature: 107, temperature_str: 107, state: 'CO', city: 'Jackyland' },
				122: { id: 122, temperature: 24, temperature_str: 24, state: 'CO', city: 'Adelberthaven' },
				134: { id: 134, temperature: 24, temperature_str: 24, state: 'CO', city: 'Gilbertstad' },
				144: { id: 144, temperature: 84, temperature_str: 84, state: 'CO', city: 'McGlynnbury' },
				217: { id: 217, temperature: 91, temperature_str: 91, state: 'CO', city: 'Chelseyfurt' },
				294: { id: 294, temperature: 78, temperature_str: 78, state: 'CO', city: 'Thomasshire' },
				375: { id: 375, temperature: 73, temperature_str: 73, state: 'CO', city: 'Wolfbury' },
				382: { id: 382, temperature: 46, temperature_str: 46, state: 'CO', city: 'South Katrina' },
				512: { id: 512, temperature: 78, temperature_str: 78, state: 'CO', city: 'Curtiston' },
				537: { id: 537, temperature: 32, temperature_str: 32, state: 'CO', city: 'North Danaview' },
				572: { id: 572, temperature: 3, temperature_str: 3, state: 'CO', city: 'East Cesarfort' },
				622: { id: 622, temperature: 27, temperature_str: 27, state: 'CO', city: 'Kalimouth' },
				682: { id: 682, temperature: 24, temperature_str: 24, state: 'CO', city: 'Lake Webster' },
				698: { id: 698, temperature: 98, temperature_str: 98, state: 'CO', city: 'Lake Cassidy' },
				781: { id: 781, temperature: 103, temperature_str: 103, state: 'CO', city: 'Port Brooke' },
				809: { id: 809, temperature: 51, temperature_str: 51, state: 'CO', city: 'Lake Chanceton' },
				855: { id: 855, temperature: 1, temperature_str: 1, state: 'CO', city: 'Hannahborough' },
			};

			let search_object = new SearchObject('dev', 'test', 'state', 'CO', 'id', ATTRIBUTES, undefined, false, 20);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.EQUALS, HASH_ATTRIBUTE_NAME, true],
				undefined
			);
			assert.deepStrictEqual(Object.keys(results).length, 20);
			assert.deepEqual(results, expected);
		});

		it('test contains on string limit 20', async () => {
			let expected = [
				{ id: 102, temperature: 98, temperature_str: 98, state: 'NM', city: 'South Gilbert' },
				{ id: 107, temperature: 33, temperature_str: 33, state: 'DE', city: 'Albertville' },
				{ id: 122, temperature: 24, temperature_str: 24, state: 'CO', city: 'Adelberthaven' },
				{ id: 134, temperature: 24, temperature_str: 24, state: 'CO', city: 'Gilbertstad' },
				{ id: 190, temperature: 50, temperature_str: 50, state: 'OH', city: 'Gilbertview' },
				{ id: 239, temperature: -1, temperature_str: -1, state: 'NJ', city: 'Dibbertview' },
				{ id: 688, temperature: -1, temperature_str: -1, state: 'AR', city: 'Webertown' },
				{ id: 728, temperature: 88, temperature_str: 88, state: 'NC', city: 'Dibberthaven' },
				{ id: 741, temperature: 89, temperature_str: 89, state: 'VT', city: 'South Wilbertfort' },
				{ id: 765, temperature: -4, temperature_str: -4, state: 'AZ', city: 'Lake Gilbertchester' },
				{ id: 923, temperature: 34, temperature_str: 34, state: 'SD', city: 'North Filibertoland' },
				{ id: 966, temperature: 38, temperature_str: 38, state: 'AL', city: 'Albertostad' },
			];

			let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ATTRIBUTES, undefined, false, 20);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 12);
			assert.deepEqual(results, expected);
		});

		it('test contains on string limit 1 offset 1', async () => {
			let expected = [{ id: 966, temperature: 38, temperature_str: 38, state: 'AL', city: 'Albertostad' }];

			let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ATTRIBUTES, undefined, false, 1, 1);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 1);
			assert.deepEqual(results, expected);
		});

		it('test contains on string limit 1 offset 20', async () => {
			let expected = [];

			let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ATTRIBUTES, undefined, false, 1, 20);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 0);
			assert.deepEqual(results, expected);
		});

		it('test contains on string reverse limit 1 offset 1', async () => {
			let expected = [{ id: 741, temperature: 89, temperature_str: 89, state: 'VT', city: 'South Wilbertfort' }];

			let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ATTRIBUTES, undefined, true, 1, 1);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 1);
			assert.deepEqual(results, expected);
		});

		it('test  contains on string return map limit 5', async () => {
			let expected = {
				107: { id: 107, temperature: 33, temperature_str: 33, state: 'DE', city: 'Albertville' },
				122: { id: 122, temperature: 24, temperature_str: 24, state: 'CO', city: 'Adelberthaven' },
				239: { id: 239, temperature: -1, temperature_str: -1, state: 'NJ', city: 'Dibbertview' },
				728: { id: 728, temperature: 88, temperature_str: 88, state: 'NC', city: 'Dibberthaven' },
				966: { id: 966, temperature: 38, temperature_str: 38, state: 'AL', city: 'Albertostad' },
			};

			let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ATTRIBUTES, undefined, false, 5);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME, true],
				undefined
			);
			assert.deepEqual(Object.keys(results).length, 5);
			assert.deepEqual(results, expected);
		});

		it('test  contains on string return map limit 5 offset 5', async () => {
			let expected = {
				102: { id: 102, temperature: 98, temperature_str: 98, state: 'NM', city: 'South Gilbert' },
				134: { id: 134, temperature: 24, temperature_str: 24, state: 'CO', city: 'Gilbertstad' },
				190: { id: 190, temperature: 50, temperature_str: 50, state: 'OH', city: 'Gilbertview' },
				765: { id: 765, temperature: -4, temperature_str: -4, state: 'AZ', city: 'Lake Gilbertchester' },
				923: { id: 923, temperature: 34, temperature_str: 34, state: 'SD', city: 'North Filibertoland' },
			};

			let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ATTRIBUTES, undefined, false, 5, 5);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME, true],
				undefined
			);
			assert.deepEqual(Object.keys(results).length, 5);
			assert.deepEqual(results, expected);
		});

		it('test  contains on string return map reverse limit 5 offset 5', async () => {
			let expected = {
				107: { id: 107, temperature: 33, temperature_str: 33, state: 'DE', city: 'Albertville' },
				134: { id: 134, temperature: 24, temperature_str: 24, state: 'CO', city: 'Gilbertstad' },
				190: { id: 190, temperature: 50, temperature_str: 50, state: 'OH', city: 'Gilbertview' },
				239: { id: 239, temperature: -1, temperature_str: -1, state: 'NJ', city: 'Dibbertview' },
				728: { id: 728, temperature: 88, temperature_str: 88, state: 'NC', city: 'Dibberthaven' },
			};

			let search_object = new SearchObject('dev', 'test', 'city', 'bert', 'id', ATTRIBUTES, undefined, true, 5, 5);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.CONTAINS, HASH_ATTRIBUTE_NAME, true],
				undefined
			);
			assert.deepEqual(Object.keys(results).length, 5);
			assert.deepEqual(results, expected);
		});

		it('test endswith on string limit 10', async () => {
			let expected = [
				{ id: 264, temperature: 30, temperature_str: 30, state: 'MN', city: 'Doyleland' },
				{ id: 287, temperature: 47, temperature_str: 47, state: 'CT', city: 'Feeneyland' },
				{ id: 310, temperature: 10, temperature_str: 10, state: 'CT', city: 'Ernestland' },
				{ id: 323, temperature: 7, temperature_str: 7, state: 'VA', city: 'Auerland' },
				{ id: 357, temperature: 35, temperature_str: 35, state: 'MT', city: 'Gaylordland' },
				{ id: 597, temperature: 53, temperature_str: 53, state: 'OH', city: 'East Gregorioland' },
				{ id: 780, temperature: 71, temperature_str: 71, state: 'AL', city: 'Howellland' },
				{ id: 801, temperature: 19, temperature_str: 19, state: 'ID', city: 'Gutkowskiland' },
				{ id: 884, temperature: 14, temperature_str: 14, state: 'VT', city: 'Alannaland' },
				{ id: 914, temperature: 108, temperature_str: 108, state: 'NH', city: 'Jacintheland' },
			];

			let search_object = new SearchObject('dev', 'test', 'city', 'land', 'id', ATTRIBUTES, undefined, false, 10);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(Object.keys(results).length, 10);
			assert.deepEqual(results, expected);
		});

		it('test endswith on string limit 10 offset 10', async () => {
			let expected = [
				{ id: 93, temperature: 107, temperature_str: 107, state: 'CO', city: 'Jackyland' },
				{ id: 175, temperature: 61, temperature_str: 61, state: 'NV', city: 'Lake Mercedesland' },
				{ id: 216, temperature: 27, temperature_str: 27, state: 'AZ', city: 'Kundeland' },
				{ id: 293, temperature: 57, temperature_str: 57, state: 'IN', city: 'Jeromeland' },
				{ id: 347, temperature: 67, temperature_str: 67, state: 'WA', city: 'Marquardtland' },
				{ id: 363, temperature: 68, temperature_str: 68, state: 'KS', city: 'Keaganland' },
				{ id: 569, temperature: 40, temperature_str: 40, state: 'RI', city: 'Josephland' },
				{ id: 661, temperature: 46, temperature_str: 46, state: 'SD', city: 'Javonteland' },
				{ id: 723, temperature: 25, temperature_str: 25, state: 'SD', city: 'Kenyonland' },
				{ id: 838, temperature: 68, temperature_str: 68, state: 'GA', city: 'Loisland' },
			];

			let search_object = new SearchObject('dev', 'test', 'city', 'land', 'id', ATTRIBUTES, undefined, false, 10, 10);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(Object.keys(results).length, 10);
			assert.deepEqual(results, expected);
		});

		it('test endswith on string reverse limit 10 offset 10', async () => {
			let expected = [
				{ id: 15, temperature: 4, temperature_str: 4, state: 'SC', city: 'Muellerland' },
				{ id: 49, temperature: 19, temperature_str: 19, state: 'MI', city: 'New Jaquelinland' },
				{ id: 92, temperature: 3, temperature_str: 3, state: 'MO', city: 'Schaeferland' },
				{ id: 175, temperature: 61, temperature_str: 61, state: 'NV', city: 'Lake Mercedesland' },
				{ id: 347, temperature: 67, temperature_str: 67, state: 'WA', city: 'Marquardtland' },
				{ id: 380, temperature: 90, temperature_str: 90, state: 'FL', city: 'Port Tamialand' },
				{ id: 602, temperature: 89, temperature_str: 89, state: 'NV', city: 'Parisianland' },
				{ id: 754, temperature: 6, temperature_str: 6, state: 'VA', city: 'Russelland' },
				{ id: 838, temperature: 68, temperature_str: 68, state: 'GA', city: 'Loisland' },
				{ id: 923, temperature: 34, temperature_str: 34, state: 'SD', city: 'North Filibertoland' },
			];

			let search_object = new SearchObject('dev', 'test', 'city', 'land', 'id', ATTRIBUTES, undefined, true, 10, 10);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.ENDS_WITH, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(Object.keys(results).length, 10);
			assert.deepEqual(results, expected);
		});

		it('test startswith on string limit 10', async () => {
			let expected = [
				{ id: 89, temperature: 53, temperature_str: 53, state: 'GA', city: 'South Bridgette' },
				{ id: 179, temperature: 58, temperature_str: 58, state: 'KS', city: 'South Boyd' },
				{ id: 186, temperature: 43, temperature_str: 43, state: 'SC', city: 'South Ashleigh' },
				{ id: 259, temperature: 78, temperature_str: 78, state: 'NV', city: 'South Aditya' },
				{ id: 374, temperature: 60, temperature_str: 60, state: 'AR', city: 'South Aliyah' },
				{ id: 469, temperature: 93, temperature_str: 93, state: 'MO', city: 'South Alec' },
				{ id: 558, temperature: 11, temperature_str: 11, state: 'WA', city: 'South Alenefurt' },
				{ id: 686, temperature: 44, temperature_str: 44, state: 'AL', city: 'South Camylle' },
				{ id: 689, temperature: -8, temperature_str: -8, state: 'OR', city: 'South Bennett' },
				{ id: 996, temperature: 0, temperature_str: 0, state: 'AR', city: 'South Carlo' },
			];

			let search_object = new SearchObject('dev', 'test', 'city', 'South', 'id', ATTRIBUTES, undefined, false, 10);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});

		it('test startswith on string limit 10 offset 10', async () => {
			let expected = [
				{ id: 102, temperature: 98, temperature_str: 98, state: 'NM', city: 'South Gilbert' },
				{ id: 108, temperature: 34, temperature_str: 34, state: 'AR', city: 'South Clemens' },
				{ id: 343, temperature: 59, temperature_str: 59, state: 'ID', city: 'South Christy' },
				{ id: 424, temperature: 60, temperature_str: 60, state: 'NJ', city: 'South Eula' },
				{ id: 495, temperature: 33, temperature_str: 33, state: 'VA', city: 'South Gisselle' },
				{ id: 674, temperature: -10, temperature_str: -10, state: 'FL', city: 'South Cody' },
				{ id: 748, temperature: 0, temperature_str: 0, state: 'AR', city: 'South Carmella' },
				{ id: 810, temperature: 48, temperature_str: 48, state: 'NH', city: 'South Deangelobury' },
				{ id: 822, temperature: 58, temperature_str: 58, state: 'ME', city: 'South Edwinaburgh' },
				{ id: 903, temperature: 14, temperature_str: 14, state: 'VA', city: 'South Enrique' },
			];

			let search_object = new SearchObject('dev', 'test', 'city', 'South', 'id', ATTRIBUTES, undefined, false, 10, 10);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});

		it('test startswith on string reverse limit 10', async () => {
			let expected = [
				{ id: 140, temperature: -2, temperature_str: -2, state: 'DC', city: 'South Stewart' },
				{ id: 193, temperature: 28, temperature_str: 28, state: 'IL', city: 'South Tony' },
				{ id: 388, temperature: 19, temperature_str: 19, state: 'NV', city: 'South Vernshire' },
				{ id: 538, temperature: 40, temperature_str: 40, state: 'MO', city: 'South Wavaborough' },
				{ id: 613, temperature: -5, temperature_str: -5, state: 'SD', city: 'South Wellington' },
				{ id: 680, temperature: 65, temperature_str: 65, state: 'ME', city: 'South Tess' },
				{ id: 741, temperature: 89, temperature_str: 89, state: 'VT', city: 'South Wilbertfort' },
				{ id: 762, temperature: 36, temperature_str: 36, state: 'NJ', city: 'South Stefaniestad' },
				{ id: 904, temperature: 66, temperature_str: 66, state: 'MO', city: 'South Sammy' },
				{ id: 951, temperature: -9, temperature_str: -9, state: 'SD', city: 'South Sigrid' },
			];

			let search_object = new SearchObject('dev', 'test', 'city', 'South', 'id', ATTRIBUTES, undefined, true, 10);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});

		it('test startswith on string reverse limit 10 offset 10', async () => {
			let expected = [
				{ id: 42, temperature: 86, temperature_str: 86, state: 'WA', city: 'South Sadie' },
				{ id: 316, temperature: 82, temperature_str: 82, state: 'KS', city: 'South Queeniefurt' },
				{ id: 467, temperature: 44, temperature_str: 44, state: 'MD', city: 'South Norenestad' },
				{ id: 559, temperature: 25, temperature_str: 25, state: 'NM', city: 'South Peter' },
				{ id: 625, temperature: 22, temperature_str: 22, state: 'KY', city: 'South Price' },
				{ id: 646, temperature: 26, temperature_str: 26, state: 'MO', city: 'South Nichole' },
				{ id: 834, temperature: 11, temperature_str: 11, state: 'OK', city: 'South Nikobury' },
				{ id: 844, temperature: 89, temperature_str: 89, state: 'AK', city: 'South Ofelia' },
				{ id: 874, temperature: 94, temperature_str: 94, state: 'CT', city: 'South Nathanielmouth' },
				{ id: 905, temperature: 83, temperature_str: 83, state: 'NM', city: 'South Rusty' },
			];

			let search_object = new SearchObject('dev', 'test', 'city', 'South', 'id', ATTRIBUTES, undefined, true, 10, 10);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.STARTS_WITH, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});

		it('test greaterthan limit 10', async () => {
			let expected = [
				{ id: 4, temperature: 27, temperature_str: 27, state: 'MT', city: 'Geovanniton' },
				{ id: 86, temperature: 27, temperature_str: 27, state: 'TN', city: 'Thompsonchester' },
				{ id: 141, temperature: 27, temperature_str: 27, state: 'VT', city: 'East Daisyfurt' },
				{ id: 158, temperature: 27, temperature_str: 27, state: 'IN', city: 'Thomaschester' },
				{ id: 216, temperature: 27, temperature_str: 27, state: 'AZ', city: 'Kundeland' },
				{ id: 298, temperature: 26, temperature_str: 26, state: 'CT', city: 'Darioton' },
				{ id: 415, temperature: 26, temperature_str: 26, state: 'NH', city: 'Kuvalismouth' },
				{ id: 454, temperature: 26, temperature_str: 26, state: 'TN', city: 'Lake Xzavierview' },
				{ id: 646, temperature: 26, temperature_str: 26, state: 'MO', city: 'South Nichole' },
				{ id: 667, temperature: 26, temperature_str: 26, state: 'AL', city: 'West Adrianstad' },
			];

			let search_object = new SearchObject('dev', 'test', 'temperature', 25, 'id', ATTRIBUTES, undefined, false, 10);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});

		it('test greaterthan limit 10 offset 10', async () => {
			let expected = [
				{ id: 16, temperature: 28, temperature_str: 28, state: 'AZ', city: 'New Donmouth' },
				{ id: 70, temperature: 28, temperature_str: 28, state: 'DC', city: 'Considineside' },
				{ id: 126, temperature: 28, temperature_str: 28, state: 'PA', city: 'Dickinsonchester' },
				{ id: 193, temperature: 28, temperature_str: 28, state: 'IL', city: 'South Tony' },
				{ id: 245, temperature: 27, temperature_str: 27, state: 'SC', city: 'Lake Deonte' },
				{ id: 309, temperature: 27, temperature_str: 27, state: 'HI', city: 'Justynside' },
				{ id: 322, temperature: 27, temperature_str: 27, state: 'MA', city: 'North Fritz' },
				{ id: 372, temperature: 28, temperature_str: 28, state: 'MN', city: 'East Julio' },
				{ id: 622, temperature: 27, temperature_str: 27, state: 'CO', city: 'Kalimouth' },
				{ id: 980, temperature: 27, temperature_str: 27, state: 'MT', city: 'West Roselynchester' },
			];

			let search_object = new SearchObject(
				'dev',
				'test',
				'temperature',
				25,
				'id',
				ATTRIBUTES,
				undefined,
				false,
				10,
				10
			);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});

		it('test greaterthanequal limit 10', async () => {
			let expected = [
				{ id: 1, temperature: 40, temperature_str: 40, state: 'AL', city: 'Lydiabury' },
				{ id: 12, temperature: 40, temperature_str: 40, state: 'IA', city: 'Willchester' },
				{ id: 24, temperature: 40, temperature_str: 40, state: 'IA', city: 'Lylafurt' },
				{ id: 138, temperature: 40, temperature_str: 40, state: 'GA', city: 'West Rhettbury' },
				{ id: 235, temperature: 40, temperature_str: 40, state: 'IA', city: 'Cameronmouth' },
				{ id: 288, temperature: 40, temperature_str: 40, state: 'MI', city: 'Deontestad' },
				{ id: 465, temperature: 40, temperature_str: 40, state: 'OH', city: 'Lake Candace' },
				{ id: 505, temperature: 40, temperature_str: 40, state: 'MN', city: 'New Leonard' },
				{ id: 538, temperature: 40, temperature_str: 40, state: 'MO', city: 'South Wavaborough' },
				{ id: 569, temperature: 40, temperature_str: 40, state: 'RI', city: 'Josephland' },
			];

			let search_object = new SearchObject('dev', 'test', 'temperature', 40, 'id', ATTRIBUTES, undefined, false, 10);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});

		it('test greaterthanequal limit 10 offset 10', async () => {
			let expected = [
				{ id: 55, temperature: 41, temperature_str: 41, state: 'MT', city: 'East Audrey' },
				{ id: 250, temperature: 41, temperature_str: 41, state: 'WV', city: 'Arielleburgh' },
				{ id: 308, temperature: 41, temperature_str: 41, state: 'GA', city: 'Maudmouth' },
				{ id: 336, temperature: 41, temperature_str: 41, state: 'WI', city: 'Nayelibury' },
				{ id: 412, temperature: 41, temperature_str: 41, state: 'NH', city: 'Swiftbury' },
				{ id: 413, temperature: 41, temperature_str: 41, state: 'VT', city: 'West Yoshiko' },
				{ id: 768, temperature: 40, temperature_str: 40, state: 'UT', city: 'West Haleigh' },
				{ id: 774, temperature: 40, temperature_str: 40, state: 'ID', city: 'Jaceyport' },
				{ id: 837, temperature: 40, temperature_str: 40, state: 'UT', city: 'West Elwinburgh' },
				{ id: 859, temperature: 40, temperature_str: 40, state: 'GA', city: 'North Anahiburgh' },
			];

			let search_object = new SearchObject(
				'dev',
				'test',
				'temperature',
				40,
				'id',
				ATTRIBUTES,
				undefined,
				false,
				10,
				10
			);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});

		it('test lessthan offset 10', async () => {
			let expected = [
				{ id: 32, temperature: -9, temperature_str: -9, state: 'KY', city: 'Ferminmouth' },
				{ id: 34, temperature: -9, temperature_str: -9, state: 'NJ', city: 'New Haydenbury' },
				{ id: 45, temperature: -9, temperature_str: -9, state: 'IL', city: 'Port Jadyn' },
				{ id: 218, temperature: -9, temperature_str: -9, state: 'OK', city: 'Claudiehaven' },
				{ id: 307, temperature: -10, temperature_str: -10, state: 'MO', city: 'Maiastad' },
				{ id: 479, temperature: -10, temperature_str: -10, state: 'IL', city: 'Tobychester' },
				{ id: 517, temperature: -10, temperature_str: -10, state: 'ND', city: 'East Tremaine' },
				{ id: 674, temperature: -10, temperature_str: -10, state: 'FL', city: 'South Cody' },
				{ id: 860, temperature: -10, temperature_str: -10, state: 'IN', city: 'Gracemouth' },
				{ id: 989, temperature: -10, temperature_str: -10, state: 'OR', city: 'Greenport' },
			];
			let search_object = new SearchObject('dev', 'test', 'temperature', 25, 'id', ATTRIBUTES, undefined, false, 10);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});

		it('test lessthan offset 10 limit 10', async () => {
			let expected = [
				{ id: 25, temperature: -7, temperature_str: -7, state: 'NM', city: 'North Rosamondburgh' },
				{ id: 371, temperature: -8, temperature_str: -8, state: 'IL', city: 'New Colten' },
				{ id: 453, temperature: -8, temperature_str: -8, state: 'WI', city: 'Scottiefurt' },
				{ id: 456, temperature: -8, temperature_str: -8, state: 'CT', city: 'North Jody' },
				{ id: 675, temperature: -9, temperature_str: -9, state: 'NY', city: 'Julietborough' },
				{ id: 689, temperature: -8, temperature_str: -8, state: 'OR', city: 'South Bennett' },
				{ id: 699, temperature: -9, temperature_str: -9, state: 'HI', city: 'West Dock' },
				{ id: 756, temperature: -7, temperature_str: -7, state: 'MD', city: 'Alexzanderport' },
				{ id: 951, temperature: -9, temperature_str: -9, state: 'SD', city: 'South Sigrid' },
				{ id: 998, temperature: -9, temperature_str: -9, state: 'CO', city: 'North Sally' },
			];
			let search_object = new SearchObject(
				'dev',
				'test',
				'temperature',
				25,
				'id',
				ATTRIBUTES,
				undefined,
				false,
				10,
				10
			);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});

		it('test lessthanequal limit 10', async () => {
			let expected = [
				{ id: 32, temperature: -9, temperature_str: -9, state: 'KY', city: 'Ferminmouth' },
				{ id: 34, temperature: -9, temperature_str: -9, state: 'NJ', city: 'New Haydenbury' },
				{ id: 45, temperature: -9, temperature_str: -9, state: 'IL', city: 'Port Jadyn' },
				{ id: 218, temperature: -9, temperature_str: -9, state: 'OK', city: 'Claudiehaven' },
				{ id: 307, temperature: -10, temperature_str: -10, state: 'MO', city: 'Maiastad' },
				{ id: 479, temperature: -10, temperature_str: -10, state: 'IL', city: 'Tobychester' },
				{ id: 517, temperature: -10, temperature_str: -10, state: 'ND', city: 'East Tremaine' },
				{ id: 674, temperature: -10, temperature_str: -10, state: 'FL', city: 'South Cody' },
				{ id: 860, temperature: -10, temperature_str: -10, state: 'IN', city: 'Gracemouth' },
				{ id: 989, temperature: -10, temperature_str: -10, state: 'OR', city: 'Greenport' },
			];
			let search_object = new SearchObject('dev', 'test', 'temperature', 40, 'id', ATTRIBUTES, undefined, false, 10);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});

		it('test lessthanequal limit 10 offset 10', async () => {
			let expected = [
				{ id: 25, temperature: -7, temperature_str: -7, state: 'NM', city: 'North Rosamondburgh' },
				{ id: 371, temperature: -8, temperature_str: -8, state: 'IL', city: 'New Colten' },
				{ id: 453, temperature: -8, temperature_str: -8, state: 'WI', city: 'Scottiefurt' },
				{ id: 456, temperature: -8, temperature_str: -8, state: 'CT', city: 'North Jody' },
				{ id: 675, temperature: -9, temperature_str: -9, state: 'NY', city: 'Julietborough' },
				{ id: 689, temperature: -8, temperature_str: -8, state: 'OR', city: 'South Bennett' },
				{ id: 699, temperature: -9, temperature_str: -9, state: 'HI', city: 'West Dock' },
				{ id: 756, temperature: -7, temperature_str: -7, state: 'MD', city: 'Alexzanderport' },
				{ id: 951, temperature: -9, temperature_str: -9, state: 'SD', city: 'South Sigrid' },
				{ id: 998, temperature: -9, temperature_str: -9, state: 'CO', city: 'North Sally' },
			];
			let search_object = new SearchObject(
				'dev',
				'test',
				'temperature',
				40,
				'id',
				ATTRIBUTES,
				undefined,
				false,
				10,
				10
			);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});

		it('test between limit 10', async () => {
			let expected = [
				{ id: 1, temperature: 40, temperature_str: 40, state: 'AL', city: 'Lydiabury' },
				{ id: 12, temperature: 40, temperature_str: 40, state: 'IA', city: 'Willchester' },
				{ id: 24, temperature: 40, temperature_str: 40, state: 'IA', city: 'Lylafurt' },
				{ id: 138, temperature: 40, temperature_str: 40, state: 'GA', city: 'West Rhettbury' },
				{ id: 235, temperature: 40, temperature_str: 40, state: 'IA', city: 'Cameronmouth' },
				{ id: 288, temperature: 40, temperature_str: 40, state: 'MI', city: 'Deontestad' },
				{ id: 465, temperature: 40, temperature_str: 40, state: 'OH', city: 'Lake Candace' },
				{ id: 505, temperature: 40, temperature_str: 40, state: 'MN', city: 'New Leonard' },
				{ id: 538, temperature: 40, temperature_str: 40, state: 'MO', city: 'South Wavaborough' },
				{ id: 569, temperature: 40, temperature_str: 40, state: 'RI', city: 'Josephland' },
			];

			let search_object = new SearchObject('dev', 'test', 'temperature', 40, 'id', ATTRIBUTES, 66, false, 10);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.BETWEEN, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});

		it('test between limit 10 offset 10', async () => {
			let expected = [
				{ id: 55, temperature: 41, temperature_str: 41, state: 'MT', city: 'East Audrey' },
				{ id: 250, temperature: 41, temperature_str: 41, state: 'WV', city: 'Arielleburgh' },
				{ id: 308, temperature: 41, temperature_str: 41, state: 'GA', city: 'Maudmouth' },
				{ id: 336, temperature: 41, temperature_str: 41, state: 'WI', city: 'Nayelibury' },
				{ id: 412, temperature: 41, temperature_str: 41, state: 'NH', city: 'Swiftbury' },
				{ id: 413, temperature: 41, temperature_str: 41, state: 'VT', city: 'West Yoshiko' },
				{ id: 768, temperature: 40, temperature_str: 40, state: 'UT', city: 'West Haleigh' },
				{ id: 774, temperature: 40, temperature_str: 40, state: 'ID', city: 'Jaceyport' },
				{ id: 837, temperature: 40, temperature_str: 40, state: 'UT', city: 'West Elwinburgh' },
				{ id: 859, temperature: 40, temperature_str: 40, state: 'GA', city: 'North Anahiburgh' },
			];

			let search_object = new SearchObject('dev', 'test', 'temperature', 40, 'id', ATTRIBUTES, 66, false, 10, 10);
			let results = await test_utils.assertErrorAsync(
				lmdb_search.executeSearch,
				[search_object, lmdb_terms.SEARCH_TYPES.BETWEEN, HASH_ATTRIBUTE_NAME],
				undefined
			);
			assert.deepEqual(results.length, 10);
			assert.deepEqual(results, expected);
		});
	});
});
