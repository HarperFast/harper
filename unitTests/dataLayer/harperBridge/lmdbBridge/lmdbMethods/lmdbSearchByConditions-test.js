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

const { handleHDBError } = require('../../../../../utility/errors/hdbError');

const test_data = require('../../../../testData');

const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const lmdb_terms = require('../../../../../utility/lmdb/terms');
const write_utility = require('../../../../../utility/lmdb/writeUtility');
const { SearchByConditionsObject, SearchCondition } = require('../../../../../dataLayer/SearchByConditionsObject');
const lmdb_search = require('../../../../../dataLayer/harperBridge/harperBridge').searchByConditions;
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');
const { sortBy } = require('lodash');
const TIMESTAMP = Date.now();

const sandbox = sinon.createSandbox();
function assertionsAsArray(test_func, args, error) {
	return test_utils.assertErrorAsync(
		async () => {
			let results = await test_func.apply(this, args);
			return Array.from(results);
		},
		args,
		error
	);
}

describe('test lmdbSearchByConditions module', () => {
	let date_stub;
	before(() => {
		date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
	});

	after(() => {
		date_stub.restore();
	});

	describe('test method', () => {
		let env;
		before(async function () {
			this.timeout(10000);
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
			await environment_utility.createDBI(env, 'temperature_pos', true);
			await environment_utility.createDBI(env, 'temperature_neg', true);
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

		it('test validation', async () => {
			await assertionsAsArray(
				lmdb_search,
				[{}],
				test_utils.generateHDBError(
					"'schema' is required. 'table' is required. 'get_attributes' is required. 'conditions' is required",
					400
				)
			);
			await assertionsAsArray(
				lmdb_search,
				[{ schema: 'dev' }],
				test_utils.generateHDBError("'table' is required. 'get_attributes' is required. 'conditions' is required", 400)
			);
			await assertionsAsArray(
				lmdb_search,
				[{ schema: 'dev', table: 'test' }],
				test_utils.generateHDBError("'get_attributes' is required. 'conditions' is required", 400)
			);
			await assertionsAsArray(
				lmdb_search,
				[{ schema: 'dev', table: 'test', get_attributes: ['*'] }],
				test_utils.generateHDBError("'conditions' is required", 400)
			);
			await assertionsAsArray(
				lmdb_search,
				[{ schema: 'dev', table: 'test', get_attributes: ['*'], conditions: [{}] }],
				test_utils.generateHDBError(
					"'conditions[0].search_attribute' is required. 'conditions[0].search_type' is required. 'conditions[0].search_value' is required",
					400
				)
			);
			await assertionsAsArray(
				lmdb_search,
				[{ schema: 'dev', table: 'test', get_attributes: ['*'], conditions: [{ search_attribute: 'city' }] }],
				test_utils.generateHDBError(
					"'conditions[0].search_type' is required. 'conditions[0].search_value' is required",
					400
				)
			);
			await assertionsAsArray(
				lmdb_search,
				[
					{
						schema: 'dev',
						table: 'test',
						get_attributes: ['*'],
						conditions: [{ search_attribute: 'city', search_type: 'equals' }],
					},
				],
				test_utils.generateHDBError("'conditions[0].search_value' is required", 400)
			);
			await assertionsAsArray(
				lmdb_search,
				[
					{
						schema: 'dev',
						table: 'test',
						get_attributes: ['*'],
						conditions: [{ search_attribute: 'city', search_type: 'equals', search_value: 'test' }],
					},
				],
				undefined
			);

			await assertionsAsArray(
				lmdb_search,
				[
					{
						schema: 'dev/sss',
						table: 'test`e`r',
						get_attributes: ['id', 'tem/p'],
						conditions: [{ search_attribute: 'ci`/ty', search_type: 'equals', search_value: 'test' }],
					},
				],
				test_utils.generateHDBError(
					"'schema' names cannot include backticks or forward slashes. 'table' names cannot include backticks or forward slashes. 'get_attributes[1]' names cannot include backticks or forward slashes. " +
						"'conditions[0].search_attribute' names cannot include backticks or forward slashes",
					400
				)
			);

			await assertionsAsArray(
				lmdb_search,
				[
					{
						schema: 'dev',
						table: 'test',
						get_attributes: ['*'],
						conditions: [{ search_attribute: 'city', search_type: 'dddd', search_value: 'test' }],
					},
				],
				test_utils.generateHDBError(
					"'conditions[0].search_type' must be one of [equals, contains, starts_with, ends_with, greater_than, greater_than_equal, less_than, less_than_equal, between]",
					400
				)
			);

			await assertionsAsArray(
				lmdb_search,
				[
					{
						schema: 'dev2',
						table: 'test',
						get_attributes: ['*'],
						conditions: [{ search_attribute: 'city', search_type: 'equals', search_value: 'Denver' }],
					},
				],
				handleHDBError(new Error(), "Schema 'dev2' does not exist", 404)
			);

			await assertionsAsArray(
				lmdb_search,
				[
					{
						schema: 'dev',
						table: 'test2',
						get_attributes: ['*'],
						conditions: [{ search_attribute: 'city', search_type: 'equals', search_value: 'Denver' }],
					},
				],
				handleHDBError(new Error(), "Table 'dev.test2' does not exist", 404)
			);

			await assertionsAsArray(
				lmdb_search,
				[
					{
						schema: 'dev',
						table: 'test',
						get_attributes: ['*'],
						conditions: [{ search_attribute: 'cityz', search_type: 'equals', search_value: 'Denver' }],
					},
				],
				test_utils.generateHDBError("unknown attribute 'cityz'", 400)
			);

			//test operator validation
			let search_object = new SearchByConditionsObject(
				'dev',
				'test',
				['*'],
				[
					{ search_attribute: 'city', search_type: 'equals', search_value: 'Denver' },
					{ search_attribute: 'city', search_type: 'equals', search_value: 'Fort Collins' },
				],
				undefined,
				undefined,
				'zzz'
			);
			await assertionsAsArray(
				lmdb_search,
				[search_object],
				test_utils.generateHDBError("'operator' must be one of [and, or]", 400)
			);
			search_object.operator = 'AND';
			await assertionsAsArray(lmdb_search, [search_object], undefined);
			search_object.operator = 'OR';
			await assertionsAsArray(lmdb_search, [search_object], undefined);

			//test limit offset validation
			search_object.limit = 'aaaa';
			search_object.offset = 'zzz';
			await assertionsAsArray(
				lmdb_search,
				[search_object],
				test_utils.generateHDBError("'offset' must be a number. 'limit' must be a number", 400)
			);

			search_object.limit = 1.1;
			search_object.offset = 22.4;
			await assertionsAsArray(
				lmdb_search,
				[search_object],
				test_utils.generateHDBError("'offset' must be an integer. 'limit' must be an integer", 400)
			);

			search_object.limit = 0;
			search_object.offset = -2;
			await assertionsAsArray(
				lmdb_search,
				[search_object],
				test_utils.generateHDBError(
					"'offset' must be greater than or equal to 0. 'limit' must be greater than or equal to 1",
					400
				)
			);
		});

		it('test equals on single condition', async () => {
			let expected = [
				{ id: 7, city: 'Quitzonside', state: 'CO', temperature: -3 },
				{ id: 23, city: 'Kaitlynfort', state: 'CO', temperature: 61 },
				{ id: 84, city: 'West Yvonneberg', state: 'CO', temperature: -6 },
				{ id: 93, city: 'Jackyland', state: 'CO', temperature: 107 },
				{ id: 122, city: 'Adelberthaven', state: 'CO', temperature: 24 },
				{ id: 134, city: 'Gilbertstad', state: 'CO', temperature: 24 },
				{ id: 144, city: 'McGlynnbury', state: 'CO', temperature: 84 },
				{ id: 217, city: 'Chelseyfurt', state: 'CO', temperature: 91 },
				{ id: 294, city: 'Thomasshire', state: 'CO', temperature: 78 },
				{ id: 375, city: 'Wolfbury', state: 'CO', temperature: 73 },
				{ id: 382, city: 'South Katrina', state: 'CO', temperature: 46 },
				{ id: 512, city: 'Curtiston', state: 'CO', temperature: 78 },
				{ id: 537, city: 'North Danaview', state: 'CO', temperature: 32 },
				{ id: 572, city: 'East Cesarfort', state: 'CO', temperature: 3 },
				{ id: 622, city: 'Kalimouth', state: 'CO', temperature: 27 },
				{ id: 682, city: 'Lake Webster', state: 'CO', temperature: 24 },
				{ id: 698, city: 'Lake Cassidy', state: 'CO', temperature: 98 },
				{ id: 781, city: 'Port Brooke', state: 'CO', temperature: 103 },
				{ id: 809, city: 'Lake Chanceton', state: 'CO', temperature: 51 },
				{ id: 855, city: 'Hannahborough', state: 'CO', temperature: 1 },
				{ id: 929, city: 'Lake Athena', state: 'CO', temperature: 105 },
				{ id: 964, city: 'Meredithshire', state: 'CO', temperature: 9 },
				{ id: 998, city: 'North Sally', state: 'CO', temperature: -9 },
			];

			let search_object = new SearchByConditionsObject(
				'dev',
				'test',
				['id', 'city', 'state', 'temperature'],
				[new SearchCondition('state', 'equals', 'CO')],
				undefined
			);
			let results = await assertionsAsArray(lmdb_search, [search_object], undefined);
			assert.deepEqual(results.length, 23);
			assert.deepEqual(results, expected);
		});

		it('test 2 conditions', async () => {
			let expected = [
				{ id: 572, city: 'East Cesarfort', state: 'CO', temperature: 3 },
				{ id: 855, city: 'Hannahborough', state: 'CO', temperature: 1 },
				{ id: 964, city: 'Meredithshire', state: 'CO', temperature: 9 },
			];

			let search_object = new SearchByConditionsObject(
				'dev',
				'test',
				['id', 'city', 'state', 'temperature'],
				[new SearchCondition('state', 'equals', 'CO'), new SearchCondition('temperature', 'between', [1, 10])],
				undefined
			);
			let results = await assertionsAsArray(lmdb_search, [search_object], undefined);
			assert.deepEqual(results.length, 3);
			assert.deepEqual(results, expected);
		});

		it('test 2 conditions w/ contains', async () => {
			let expected = [{ id: 810, state: 'NH', city: 'South Deangelobury' }];

			let search_object = new SearchByConditionsObject(
				'dev',
				'test',
				['id', 'city', 'state'],
				[
					new SearchCondition('city', lmdb_terms.SEARCH_TYPES.CONTAINS, 'angel'),
					new SearchCondition('state', 'equals', 'NH'),
				],
				undefined
			);
			let results = await assertionsAsArray(lmdb_search, [search_object], undefined);
			assert.deepEqual(results.length, 1);
			assert.deepEqual(results, expected);
		});

		it('test 2 conditions w/ ends-with', async () => {
			let expected = [
				{
					city: 'Swiftbury',
					id: 412,
					state: 'NH',
				},
				{
					city: 'South Deangelobury',
					id: 810,
					state: 'NH',
				},
				{
					city: 'Timothybury',
					id: 938,
					state: 'NH',
				},
			];

			let search_object = new SearchByConditionsObject(
				'dev',
				'test',
				['id', 'city', 'state'],
				[new SearchCondition('city', 'ends_with', 'bury'), new SearchCondition('state', 'equals', 'NH')],
				undefined
			);
			let results = await assertionsAsArray(lmdb_search, [search_object], undefined);
			assert.deepEqual(results.length, 3);
			assert.deepEqual(results, expected);
		});

		it('test 2 conditions w/ starts-with', async () => {
			let expected = [
				{
					city: 'Port Tamialand',
					id: 380,
					state: 'FL',
				},
				{
					city: 'Port Gabrielle',
					id: 640,
					state: 'FL',
				},
				{
					city: 'Port Amiya',
					id: 990,
					state: 'FL',
				},
			];

			let search_object = new SearchByConditionsObject(
				'dev',
				'test',
				['id', 'city', 'state'],
				[new SearchCondition('city', 'starts_with', 'Port'), new SearchCondition('state', 'equals', 'FL')],
				undefined
			);
			let results = await assertionsAsArray(lmdb_search, [search_object], undefined);
			assert.deepEqual(results.length, 3);
			assert.deepEqual(results, expected);
		});

		it('test 2 conditions w/ greater than', async () => {
			let expected = [
				{
					city: 'Lake Devinmouth',
					id: 106,
					state: 'FL',
					temperature: 94,
				},
				{
					city: 'Eleonoreview',
					id: 194,
					state: 'FL',
					temperature: 96,
				},
				{
					city: 'Mayertside',
					id: 289,
					state: 'FL',
					temperature: 96,
				},
				{
					city: 'Britneyshire',
					id: 769,
					state: 'FL',
					temperature: 91,
				},
			];

			let search_object = new SearchByConditionsObject(
				'dev',
				'test',
				['id', 'city', 'state', 'temperature'],
				[new SearchCondition('temperature', 'greater_than', 90), new SearchCondition('state', 'equals', 'FL')],
				undefined
			);
			let results = await assertionsAsArray(lmdb_search, [search_object], undefined);
			assert.deepEqual(results.length, 4);
			assert.deepEqual(results, expected);
		});

		it('test 2 conditions w/ greater than or equal', async () => {
			let expected = [
				{
					city: 'Lake Devinmouth',
					id: 106,
					state: 'FL',
					temperature: 94,
				},
				{
					city: 'Eleonoreview',
					id: 194,
					state: 'FL',
					temperature: 96,
				},
				{
					city: 'Mayertside',
					id: 289,
					state: 'FL',
					temperature: 96,
				},
				{
					city: 'Port Tamialand',
					id: 380,
					state: 'FL',
					temperature: 90,
				},
				{
					city: 'Britneyshire',
					id: 769,
					state: 'FL',
					temperature: 91,
				},
			];

			let search_object = new SearchByConditionsObject(
				'dev',
				'test',
				['id', 'city', 'state', 'temperature'],
				[new SearchCondition('temperature', 'greater_than_equal', 90), new SearchCondition('state', 'equals', 'FL')],
				undefined
			);
			let results = await assertionsAsArray(lmdb_search, [search_object], undefined);
			assert.deepEqual(results.length, 5);
			assert.deepEqual(results, expected);
		});

		it('test 2 conditions w/ less than', async () => {
			let expected = [
				{
					city: 'East Deangelo',
					id: 6,
					state: 'UT',
					temperature: -2,
				},
				{
					city: 'Lake Emily',
					id: 842,
					state: 'UT',
					temperature: -3,
				},
			];

			let search_object = new SearchByConditionsObject(
				'dev',
				'test',
				['id', 'city', 'state', 'temperature'],
				[new SearchCondition('temperature', 'less_than', 2), new SearchCondition('state', 'equals', 'UT')],
				undefined
			);
			let results = await assertionsAsArray(lmdb_search, [search_object], undefined);
			assert.deepEqual(results.length, 2);
			assert.deepEqual(results, expected);
		});

		it('test 2 conditions w/ less than or equal', async () => {
			let expected = [
				{
					city: 'East Deangelo',
					id: 6,
					state: 'UT',
					temperature: -2,
				},
				{
					city: 'Cecilehaven',
					id: 297,
					state: 'UT',
					temperature: 2,
				},
				{
					city: 'Lake Emily',
					id: 842,
					state: 'UT',
					temperature: -3,
				},
			];

			let search_object = new SearchByConditionsObject(
				'dev',
				'test',
				['id', 'city', 'state', 'temperature'],
				[new SearchCondition('temperature', 'less_than_equal', 2), new SearchCondition('state', 'equals', 'UT')],
				undefined
			);
			let results = await assertionsAsArray(lmdb_search, [search_object], undefined);
			assert.deepEqual(results.length, 3);
			assert.deepEqual(results, expected);
		});

		it('test 2 OR conditions', async () => {
			let expected = [
				{ id: 7, city: 'Quitzonside', state: 'CO', temperature: -3 },
				{ id: 10, city: 'Guiseppeside', state: 'WV', temperature: 106 },
				{ id: 18, city: 'Lake Ednashire', state: 'MO', temperature: 80 },
				{ id: 20, city: 'Corafort', state: 'RI', temperature: 76 },
				{ id: 21, city: 'Randistad', state: 'ME', temperature: 99 },
				{ id: 23, city: 'Kaitlynfort', state: 'CO', temperature: 61 },
				{ id: 37, city: 'Port Kobe', state: 'MD', temperature: 103 },
				{ id: 38, city: 'Rossmouth', state: 'CT', temperature: 78 },
				{ id: 41, city: 'Concepcionmouth', state: 'WA', temperature: 83 },
				{ id: 42, city: 'South Sadie', state: 'WA', temperature: 86 },
				{ id: 43, city: 'South Marlonfurt', state: 'WV', temperature: 81 },
				{ id: 44, city: 'McKenziemouth', state: 'MS', temperature: 86 },
				{ id: 47, city: 'Lake Mina', state: 'NH', temperature: 82 },
				{ id: 56, city: 'Lake Grayce', state: 'MT', temperature: 83 },
				{ id: 60, city: 'West Perry', state: 'PA', temperature: 97 },
				{ id: 65, city: 'Kubtown', state: 'WV', temperature: 108 },
				{ id: 67, city: 'North Amir', state: 'PA', temperature: 101 },
				{ id: 68, city: 'North Xzavier', state: 'WV', temperature: 93 },
				{ id: 73, city: 'Lake Meredith', state: 'MD', temperature: 77 },
				{ id: 74, city: 'South Maeve', state: 'NC', temperature: 100 },
				{ id: 76, city: 'Port Casey', state: 'AR', temperature: 90 },
				{ id: 81, city: 'Alvertamouth', state: 'RI', temperature: 94 },
				{ id: 84, city: 'West Yvonneberg', state: 'CO', temperature: -6 },
				{ id: 88, city: 'Boyleside', state: 'MT', temperature: 90 },
				{ id: 90, city: 'Orvillefurt', state: 'HI', temperature: 91 },
				{ id: 93, city: 'Jackyland', state: 'CO', temperature: 107 },
				{ id: 94, city: 'West Charityview', state: 'SD', temperature: 99 },
				{ id: 95, city: 'East Heather', state: 'OK', temperature: 88 },
				{ id: 97, city: 'West Generalville', state: 'ID', temperature: 102 },
				{ id: 98, city: 'Kemmerfort', state: 'OH', temperature: 76 },
				{ id: 100, city: 'South Horace', state: 'MI', temperature: 81 },
				{ id: 101, city: 'Kassulkeside', state: 'WV', temperature: 85 },
				{ id: 102, city: 'South Gilbert', state: 'NM', temperature: 98 },
				{ id: 106, city: 'Lake Devinmouth', state: 'FL', temperature: 94 },
				{ id: 111, city: 'Buckridgechester', state: 'NJ', temperature: 88 },
				{ id: 115, city: 'Osinskimouth', state: 'IN', temperature: 89 },
				{ id: 118, city: 'Elmiramouth', state: 'IN', temperature: 93 },
				{ id: 122, city: 'Adelberthaven', state: 'CO', temperature: 24 },
				{ id: 124, city: 'Theronport', state: 'TN', temperature: 94 },
				{ id: 134, city: 'Gilbertstad', state: 'CO', temperature: 24 },
				{ id: 136, city: 'Keshawnmouth', state: 'TN', temperature: 102 },
				{ id: 144, city: 'McGlynnbury', state: 'CO', temperature: 84 },
				{ id: 145, city: 'New Yazmin', state: 'UT', temperature: 80 },
				{ id: 154, city: 'Brianstad', state: 'ME', temperature: 102 },
				{ id: 156, city: 'New Cristinaville', state: 'LA', temperature: 100 },
				{ id: 160, city: 'Cadenview', state: 'OR', temperature: 107 },
				{ id: 162, city: 'West Shirley', state: 'WV', temperature: 92 },
				{ id: 166, city: 'New Nolan', state: 'IL', temperature: 94 },
				{ id: 168, city: 'Herminamouth', state: 'AR', temperature: 104 },
				{ id: 173, city: 'East Adolph', state: 'CA', temperature: 78 },
				{ id: 174, city: 'West Elvie', state: 'ME', temperature: 80 },
				{ id: 176, city: 'Pacochaberg', state: 'MI', temperature: 76 },
				{ id: 180, city: 'Joshuahton', state: 'MD', temperature: 86 },
				{ id: 183, city: 'Rowenaview', state: 'DC', temperature: 95 },
				{ id: 184, city: 'Port Hillary', state: 'NE', temperature: 99 },
				{ id: 188, city: 'South Jarredshire', state: 'NE', temperature: 86 },
				{ id: 189, city: 'Rasheedburgh', state: 'MS', temperature: 96 },
				{ id: 191, city: 'East Garnettshire', state: 'MN', temperature: 81 },
				{ id: 194, city: 'Eleonoreview', state: 'FL', temperature: 96 },
				{ id: 202, city: 'South Lucy', state: 'NC', temperature: 85 },
				{ id: 206, city: 'Elsieview', state: 'DC', temperature: 81 },
				{ id: 208, city: 'New Neil', state: 'AR', temperature: 93 },
				{ id: 209, city: 'West Betteland', state: 'NC', temperature: 88 },
				{ id: 213, city: 'New Tabitha', state: 'ME', temperature: 101 },
				{ id: 214, city: 'Dorcashaven', state: 'MN', temperature: 84 },
				{ id: 215, city: 'McKenzieville', state: 'RI', temperature: 76 },
				{ id: 217, city: 'Chelseyfurt', state: 'CO', temperature: 91 },
				{ id: 220, city: 'Deckowfort', state: 'OH', temperature: 100 },
				{ id: 227, city: 'Josestad', state: 'SC', temperature: 82 },
				{ id: 231, city: 'Gottliebstad', state: 'DC', temperature: 97 },
				{ id: 240, city: 'Lake Jaylinview', state: 'DE', temperature: 92 },
				{ id: 244, city: 'Port Damarisstad', state: 'ID', temperature: 95 },
				{ id: 248, city: 'Aiyanaview', state: 'UT', temperature: 83 },
				{ id: 249, city: 'Kohlerport', state: 'MN', temperature: 76 },
				{ id: 256, city: 'Germainestad', state: 'TX', temperature: 76 },
				{ id: 258, city: 'Olatown', state: 'RI', temperature: 90 },
				{ id: 259, city: 'South Aditya', state: 'NV', temperature: 78 },
				{ id: 265, city: 'Damionstad', state: 'UT', temperature: 93 },
				{ id: 266, city: 'Roycechester', state: 'KY', temperature: 83 },
				{ id: 270, city: 'Violetteshire', state: 'AZ', temperature: 108 },
				{ id: 271, city: 'Lake Glenna', state: 'IN', temperature: 81 },
				{ id: 274, city: 'Stanleyside', state: 'DE', temperature: 93 },
				{ id: 283, city: 'Leuschkeville', state: 'MN', temperature: 80 },
				{ id: 289, city: 'Mayertside', state: 'FL', temperature: 96 },
				{ id: 291, city: 'New Else', state: 'WI', temperature: 79 },
				{ id: 294, city: 'Thomasshire', state: 'CO', temperature: 78 },
				{ id: 295, city: 'Katelynborough', state: 'KY', temperature: 80 },
				{ id: 299, city: 'New Jerrod', state: 'WI', temperature: 98 },
				{ id: 301, city: 'Juwanmouth', state: 'IN', temperature: 98 },
				{ id: 305, city: 'West Erichville', state: 'PA', temperature: 107 },
				{ id: 316, city: 'South Queeniefurt', state: 'KS', temperature: 82 },
				{ id: 318, city: 'North Maximilian', state: 'ID', temperature: 91 },
				{ id: 326, city: 'New Ressiefurt', state: 'NH', temperature: 90 },
				{ id: 329, city: 'Lucyton', state: 'KS', temperature: 94 },
				{ id: 331, city: 'Mosciskibury', state: 'NE', temperature: 90 },
				{ id: 334, city: 'North Vanessa', state: 'NC', temperature: 103 },
				{ id: 338, city: 'Port Mariahside', state: 'ME', temperature: 99 },
				{ id: 340, city: 'Batzville', state: 'OR', temperature: 82 },
				{ id: 342, city: 'Faustinomouth', state: 'ND', temperature: 107 },
				{ id: 344, city: 'Bergeville', state: 'NY', temperature: 89 },
				{ id: 351, city: 'Roobborough', state: 'IN', temperature: 103 },
				{ id: 355, city: 'South Jamir', state: 'GA', temperature: 105 },
				{ id: 366, city: 'New Arianestad', state: 'MN', temperature: 99 },
				{ id: 373, city: 'West Larue', state: 'LA', temperature: 83 },
				{ id: 375, city: 'Wolfbury', state: 'CO', temperature: 73 },
				{ id: 380, city: 'Port Tamialand', state: 'FL', temperature: 90 },
				{ id: 382, city: 'South Katrina', state: 'CO', temperature: 46 },
				{ id: 391, city: 'Janyfort', state: 'AR', temperature: 108 },
				{ id: 394, city: 'Amandaton', state: 'IA', temperature: 96 },
				{ id: 401, city: 'Lake Naomie', state: 'MI', temperature: 98 },
				{ id: 406, city: 'Kozeyton', state: 'DE', temperature: 77 },
				{ id: 408, city: 'North Bette', state: 'MN', temperature: 100 },
				{ id: 411, city: 'Haleymouth', state: 'CA', temperature: 93 },
				{ id: 414, city: 'New Tomas', state: 'NH', temperature: 95 },
				{ id: 416, city: 'Eichmannfort', state: 'WA', temperature: 107 },
				{ id: 417, city: 'Maximofurt', state: 'WY', temperature: 76 },
				{ id: 422, city: 'Noeborough', state: 'PA', temperature: 92 },
				{ id: 423, city: 'Port Amiya', state: 'NY', temperature: 89 },
				{ id: 428, city: 'Schroedershire', state: 'RI', temperature: 83 },
				{ id: 434, city: 'Gaybury', state: 'SC', temperature: 80 },
				{ id: 435, city: 'Alizehaven', state: 'FL', temperature: 85 },
				{ id: 438, city: 'West Brenden', state: 'IA', temperature: 88 },
				{ id: 441, city: 'Lake Helene', state: 'SC', temperature: 87 },
				{ id: 442, city: 'Aidanborough', state: 'TN', temperature: 82 },
				{ id: 447, city: 'West Ayla', state: 'IA', temperature: 90 },
				{ id: 452, city: 'Tellyberg', state: 'AR', temperature: 79 },
				{ id: 455, city: 'North Noemy', state: 'NJ', temperature: 93 },
				{ id: 458, city: 'Port Frida', state: 'ME', temperature: 88 },
				{ id: 463, city: 'New Maia', state: 'NE', temperature: 95 },
				{ id: 464, city: 'Arianeberg', state: 'OR', temperature: 80 },
				{ id: 469, city: 'South Alec', state: 'MO', temperature: 93 },
				{ id: 470, city: 'Cobyfurt', state: 'ME', temperature: 76 },
				{ id: 475, city: 'Bechtelarstad', state: 'WV', temperature: 107 },
				{ id: 477, city: 'East Maxine', state: 'ND', temperature: 80 },
				{ id: 483, city: 'Bernadineville', state: 'WA', temperature: 83 },
				{ id: 485, city: 'Lake Moriah', state: 'ID', temperature: 109 },
				{ id: 493, city: 'East Johnmouth', state: 'PA', temperature: 83 },
				{ id: 494, city: 'New Betsy', state: 'NJ', temperature: 87 },
				{ id: 499, city: 'New Karolann', state: 'MO', temperature: 106 },
				{ id: 500, city: 'East Kenny', state: 'NY', temperature: 91 },
				{ id: 501, city: 'Jacintoside', state: 'DC', temperature: 95 },
				{ id: 503, city: 'Cordiatown', state: 'IA', temperature: 86 },
				{ id: 507, city: 'Thorastad', state: 'OH', temperature: 100 },
				{ id: 511, city: 'South Kennyview', state: 'KY', temperature: 90 },
				{ id: 512, city: 'Curtiston', state: 'CO', temperature: 78 },
				{ id: 514, city: 'Blandaview', state: 'WI', temperature: 78 },
				{ id: 516, city: 'West Jackie', state: 'TX', temperature: 84 },
				{ id: 521, city: 'Emilfort', state: 'IL', temperature: 102 },
				{ id: 522, city: 'Jastport', state: 'WA', temperature: 98 },
				{ id: 529, city: 'North Edmundview', state: 'AL', temperature: 89 },
				{ id: 530, city: 'Verdatown', state: 'LA', temperature: 83 },
				{ id: 537, city: 'North Danaview', state: 'CO', temperature: 32 },
				{ id: 539, city: 'Troyview', state: 'OH', temperature: 85 },
				{ id: 541, city: 'Dickinsonchester', state: 'OR', temperature: 91 },
				{ id: 542, city: 'Adellmouth', state: 'WV', temperature: 77 },
				{ id: 544, city: 'North Jordanchester', state: 'WI', temperature: 104 },
				{ id: 546, city: 'Kathlynmouth', state: 'MA', temperature: 87 },
				{ id: 549, city: 'Dorianview', state: 'LA', temperature: 108 },
				{ id: 550, city: 'North Velma', state: 'DC', temperature: 86 },
				{ id: 552, city: 'Breitenbergfurt', state: 'OK', temperature: 94 },
				{ id: 553, city: 'West Odiebury', state: 'RI', temperature: 89 },
				{ id: 554, city: 'East Laurence', state: 'CA', temperature: 97 },
				{ id: 556, city: 'North Ladarius', state: 'TN', temperature: 101 },
				{ id: 560, city: 'Port Pauline', state: 'LA', temperature: 77 },
				{ id: 564, city: 'Marvinfurt', state: 'ID', temperature: 88 },
				{ id: 565, city: 'East Ellisville', state: 'MA', temperature: 97 },
				{ id: 571, city: 'Jameymouth', state: 'OR', temperature: 93 },
				{ id: 572, city: 'East Cesarfort', state: 'CO', temperature: 3 },
				{ id: 579, city: 'New Rowlandbury', state: 'ID', temperature: 90 },
				{ id: 581, city: 'Riceville', state: 'MT', temperature: 76 },
				{ id: 582, city: 'Russelmouth', state: 'WI', temperature: 88 },
				{ id: 585, city: 'Amiraberg', state: 'NC', temperature: 90 },
				{ id: 586, city: 'South Morris', state: 'NV', temperature: 89 },
				{ id: 591, city: 'Tobyton', state: 'MA', temperature: 96 },
				{ id: 593, city: 'Kleinchester', state: 'CA', temperature: 98 },
				{ id: 600, city: 'West Ernestomouth', state: 'KY', temperature: 106 },
				{ id: 601, city: 'Crystalton', state: 'ME', temperature: 82 },
				{ id: 602, city: 'Parisianland', state: 'NV', temperature: 89 },
				{ id: 603, city: 'Funkburgh', state: 'MD', temperature: 81 },
				{ id: 606, city: 'Izaiahchester', state: 'OH', temperature: 92 },
				{ id: 608, city: 'New Dewayne', state: 'NY', temperature: 84 },
				{ id: 616, city: 'Collierstad', state: 'MD', temperature: 106 },
				{ id: 617, city: 'Wisozkmouth', state: 'MS', temperature: 84 },
				{ id: 622, city: 'Kalimouth', state: 'CO', temperature: 27 },
				{ id: 624, city: 'New Maudestad', state: 'MO', temperature: 82 },
				{ id: 629, city: 'New Micah', state: 'MN', temperature: 92 },
				{ id: 638, city: 'Bryonstad', state: 'OH', temperature: 103 },
				{ id: 642, city: 'West Antoniettaville', state: 'VT', temperature: 109 },
				{ id: 644, city: 'Port Brantside', state: 'OH', temperature: 97 },
				{ id: 652, city: 'Port Jovanny', state: 'OH', temperature: 88 },
				{ id: 654, city: 'Elishabury', state: 'OK', temperature: 77 },
				{ id: 655, city: 'East Mylene', state: 'NJ', temperature: 80 },
				{ id: 660, city: 'Ankundingborough', state: 'AL', temperature: 77 },
				{ id: 666, city: 'Runolfsdottirmouth', state: 'ID', temperature: 93 },
				{ id: 671, city: 'East Caterina', state: 'IL', temperature: 80 },
				{ id: 673, city: 'West Vickieton', state: 'GA', temperature: 76 },
				{ id: 678, city: 'Miltonberg', state: 'IL', temperature: 92 },
				{ id: 682, city: 'Lake Webster', state: 'CO', temperature: 24 },
				{ id: 685, city: 'South Jaren', state: 'OR', temperature: 106 },
				{ id: 692, city: 'Port Abechester', state: 'PA', temperature: 95 },
				{ id: 698, city: 'Lake Cassidy', state: 'CO', temperature: 98 },
				{ id: 700, city: 'Kaileyburgh', state: 'AL', temperature: 89 },
				{ id: 701, city: 'Lake Moshehaven', state: 'IN', temperature: 106 },
				{ id: 703, city: 'Port Sage', state: 'WY', temperature: 84 },
				{ id: 704, city: 'West Zachary', state: 'SC', temperature: 106 },
				{ id: 714, city: 'Mikaylafurt', state: 'DE', temperature: 101 },
				{ id: 728, city: 'Dibberthaven', state: 'NC', temperature: 88 },
				{ id: 733, city: 'Lake Domenicaborough', state: 'ID', temperature: 93 },
				{ id: 739, city: 'West Shayne', state: 'ME', temperature: 104 },
				{ id: 741, city: 'South Wilbertfort', state: 'VT', temperature: 89 },
				{ id: 747, city: 'Franzfurt', state: 'MO', temperature: 102 },
				{ id: 750, city: 'Christborough', state: 'DE', temperature: 96 },
				{ id: 751, city: 'West Vitafurt', state: 'KY', temperature: 103 },
				{ id: 757, city: 'Reganborough', state: 'NC', temperature: 87 },
				{ id: 759, city: 'Janniebury', state: 'KY', temperature: 90 },
				{ id: 760, city: 'West Wilford', state: 'WA', temperature: 84 },
				{ id: 761, city: 'West Manuela', state: 'ME', temperature: 98 },
				{ id: 769, city: 'Britneyshire', state: 'FL', temperature: 91 },
				{ id: 771, city: 'West Dahlia', state: 'MA', temperature: 87 },
				{ id: 772, city: 'New Modestochester', state: 'KY', temperature: 84 },
				{ id: 779, city: 'Mabelleborough', state: 'MN', temperature: 96 },
				{ id: 781, city: 'Port Brooke', state: 'CO', temperature: 103 },
				{ id: 783, city: 'Port Maverick', state: 'SD', temperature: 77 },
				{ id: 785, city: 'Jerrellmouth', state: 'MN', temperature: 87 },
				{ id: 797, city: 'East Jesus', state: 'WA', temperature: 85 },
				{ id: 808, city: 'West Fordborough', state: 'MA', temperature: 102 },
				{ id: 809, city: 'Lake Chanceton', state: 'CO', temperature: 51 },
				{ id: 813, city: 'East Broderick', state: 'MT', temperature: 107 },
				{ id: 815, city: 'Fadelhaven', state: 'NV', temperature: 80 },
				{ id: 817, city: 'East Tyrell', state: 'NY', temperature: 87 },
				{ id: 819, city: 'New Caitlyn', state: 'MS', temperature: 82 },
				{ id: 820, city: 'East Olga', state: 'AL', temperature: 83 },
				{ id: 825, city: 'Kendallbury', state: 'CA', temperature: 93 },
				{ id: 829, city: 'West Tiana', state: 'NV', temperature: 109 },
				{ id: 831, city: 'New Dean', state: 'AZ', temperature: 78 },
				{ id: 836, city: 'Bonniemouth', state: 'IL', temperature: 89 },
				{ id: 840, city: 'Mollychester', state: 'NM', temperature: 96 },
				{ id: 841, city: 'Ottismouth', state: 'AZ', temperature: 103 },
				{ id: 844, city: 'South Ofelia', state: 'AK', temperature: 89 },
				{ id: 845, city: 'New Khalid', state: 'MN', temperature: 88 },
				{ id: 847, city: 'Kodyburgh', state: 'MN', temperature: 82 },
				{ id: 849, city: 'Ratkestad', state: 'NY', temperature: 93 },
				{ id: 855, city: 'Hannahborough', state: 'CO', temperature: 1 },
				{ id: 856, city: 'West Ephraim', state: 'LA', temperature: 91 },
				{ id: 857, city: 'Eugeneborough', state: 'ND', temperature: 81 },
				{ id: 858, city: 'East Armand', state: 'VT', temperature: 78 },
				{ id: 861, city: 'Kaitlinmouth', state: 'PA', temperature: 77 },
				{ id: 863, city: 'Eltaville', state: 'WI', temperature: 109 },
				{ id: 868, city: 'West Ashton', state: 'MD', temperature: 79 },
				{ id: 874, city: 'South Nathanielmouth', state: 'CT', temperature: 94 },
				{ id: 885, city: 'Jenkinsview', state: 'IL', temperature: 98 },
				{ id: 895, city: 'Adamsshire', state: 'MN', temperature: 80 },
				{ id: 899, city: 'Lavadaside', state: 'WA', temperature: 90 },
				{ id: 905, city: 'South Rusty', state: 'NM', temperature: 83 },
				{ id: 910, city: 'Glenfort', state: 'OR', temperature: 97 },
				{ id: 912, city: 'West Nolan', state: 'WV', temperature: 98 },
				{ id: 913, city: 'Aufderharside', state: 'MN', temperature: 86 },
				{ id: 914, city: 'Jacintheland', state: 'NH', temperature: 108 },
				{ id: 922, city: 'Jarretview', state: 'WI', temperature: 82 },
				{ id: 926, city: 'Port Maia', state: 'VT', temperature: 95 },
				{ id: 929, city: 'Lake Athena', state: 'CO', temperature: 105 },
				{ id: 940, city: 'Darrenstad', state: 'SC', temperature: 103 },
				{ id: 943, city: 'Port Kira', state: 'IA', temperature: 90 },
				{ id: 946, city: 'Mitchellfort', state: 'HI', temperature: 107 },
				{ id: 950, city: 'New Jace', state: 'HI', temperature: 81 },
				{ id: 954, city: 'Beckerhaven', state: 'NH', temperature: 90 },
				{ id: 955, city: 'East Peggie', state: 'OR', temperature: 94 },
				{ id: 956, city: 'Marleeburgh', state: 'NE', temperature: 102 },
				{ id: 957, city: 'New Tavares', state: 'NM', temperature: 103 },
				{ id: 958, city: 'Jasperfurt', state: 'SC', temperature: 77 },
				{ id: 959, city: 'New Madisen', state: 'CA', temperature: 83 },
				{ id: 960, city: 'Brianton', state: 'FL', temperature: 76 },
				{ id: 964, city: 'Meredithshire', state: 'CO', temperature: 9 },
				{ id: 970, city: 'Lake Francesco', state: 'KS', temperature: 76 },
				{ id: 972, city: 'New Carolina', state: 'NE', temperature: 78 },
				{ id: 974, city: 'Rickhaven', state: 'OH', temperature: 79 },
				{ id: 976, city: 'New Walter', state: 'MA', temperature: 83 },
				{ id: 982, city: 'Ezrabury', state: 'LA', temperature: 78 },
				{ id: 983, city: 'Gabrielleport', state: 'TX', temperature: 86 },
				{ id: 988, city: 'New Vida', state: 'TX', temperature: 89 },
				{ id: 993, city: 'Grayceport', state: 'DE', temperature: 107 },
				{ id: 994, city: 'West Laurianechester', state: 'TN', temperature: 97 },
				{ id: 997, city: 'Edwinaborough', state: 'CT', temperature: 87 },
				{ id: 998, city: 'North Sally', state: 'CO', temperature: -9 },
				{ id: 1000, city: 'Lake Luciousstad', state: 'PA', temperature: 111 },
			];

			let search_object = new SearchByConditionsObject(
				'dev',
				'test',
				['id', 'city', 'state', 'temperature'],
				[new SearchCondition('state', 'equals', 'CO'), new SearchCondition('temperature', 'greater_than', 75)],
				undefined,
				undefined,
				'or'
			);
			let results = await assertionsAsArray(lmdb_search, [search_object], undefined);
			assert.deepEqual(results.length, 285);
			results = sortBy(results, (location) => +location.id);
			assert.deepEqual(results, expected);
		});

		it('test 2 OR conditions with limit', async () => {
			let expected = [
				{
					city: 'Bergeville',
					id: 344,
					state: 'NY',
					temperature: 89,
				},
				{
					city: 'Lake Moriah',
					id: 485,
					state: 'ID',
					temperature: 109,
				},
				{
					city: 'West Antoniettaville',
					id: 642,
					state: 'VT',
					temperature: 109,
				},
				{
					city: 'West Tiana',
					id: 829,
					state: 'NV',
					temperature: 109,
				},
				{
					city: 'Eltaville',
					id: 863,
					state: 'WI',
					temperature: 109,
				},
			];

			let search_object = new SearchByConditionsObject(
				'dev',
				'test',
				['id', 'city', 'state', 'temperature'],
				[new SearchCondition('city', 'equals', 'Bergeville'), new SearchCondition('temperature', 'greater_than', 108)],
				5,
				undefined,
				'or'
			);
			let results = await assertionsAsArray(lmdb_search, [search_object], undefined);
			assert.deepEqual(results.length, 5);
			results = sortBy(results, (location) => +location.id);
			assert.deepEqual(results, expected);
		});

		it('test 2 OR conditions with offset limit', async () => {
			let expected = [
				{
					city: 'West Antoniettaville',
					id: 642,
					state: 'VT',
					temperature: 109,
				},
				{
					city: 'West Tiana',
					id: 829,
					state: 'NV',
					temperature: 109,
				},
				{
					city: 'Eltaville',
					id: 863,
					state: 'WI',
					temperature: 109,
				},
			];

			let search_object = new SearchByConditionsObject(
				'dev',
				'test',
				['id', 'city', 'state', 'temperature'],
				[new SearchCondition('city', 'equals', 'Bergeville'), new SearchCondition('temperature', 'greater_than', 108)],
				3,
				2,
				'or'
			);
			let results = await assertionsAsArray(lmdb_search, [search_object], undefined);
			//assert.deepEqual(results.length, 100);
			assert.deepEqual(results, expected);
		});
	});
});
