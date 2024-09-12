'use strict';

const rewire = require('rewire');
const search_util = rewire('../../../utility/lmdb/searchUtility');
const fs = require('fs-extra');
const environment_utility = rewire('../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../utility/lmdb/writeUtility');
const test_utils = require('../../test_utils');
const path = require('path');
const assert = require('assert');
const test_data = require('../../personData.json');
const sinon = require('sinon');
const arrayOfValues = test_utils.arrayOfValues;
const uuid = require('uuid').v4;
const sandbox = sinon.createSandbox();
const BASE_TEST_PATH = path.join(test_utils.getMockLMDBPath(), 'lmdbTest');
let TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';

const PERSON_ATTRIBUTES = ['id', 'first_name', 'state', 'age', 'alive', 'birth_month'];
const All_ATTRIBUTES = ['id', 'name', 'age', 'city'];
const TIMESTAMP = Date.now();
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;
const MULTI_RECORD_ARRAY2 = [
	{ id: 1, name: 'Kyle', age: 46, city: 'Denver' },
	{ id: 2, name: 'Jerry', age: 32 },
	{ id: 3, name: 'Hank', age: 57 },
	{ id: 4, name: 'Joy', age: 44, city: 'Denver' },
	{ id: 5, name: 'Fran', age: 44, city: 'Denvertown' },
	{ id: 6, city: 'Nowhere' },
];

describe('test startsWith function', () => {
	let env, transaction;
	before(async () => {
		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
		await fs.mkdirp(BASE_TEST_PATH);
		TEST_ENVIRONMENT_NAME = uuid();
		env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
		await environment_utility.createDBI(env, 'id', false, true);
		await write_utility.insertRecords(
			env,
			HASH_ATTRIBUTE_NAME,
			test_utils.deepClone(All_ATTRIBUTES),
			MULTI_RECORD_ARRAY2
		);

		let more_rows = [
			{ id: 211, mush: 2 },
			{ id: 212, mush: 3 },
			{ id: 213, mush: 22 },
			{ id: 214, mush: 22.2 },
			{ id: 215, mush: '22flavors' },
			{ id: 215, mush: 'flavors' },
			{ id: 215, mush: '2flavors' },
			{ id: 215, mush: '3flavors' },
		];

		await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, ['id', 'mush'], more_rows);
		transaction = env.useReadTransaction();
		transaction.database = env;
	});

	after(async () => {
		await env.close();

		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
	});

	it('test validation', () => {
		test_utils.assertErrorSync(search_util.startsWith, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
		test_utils.assertErrorSync(
			search_util.startsWith,
			[HASH_ATTRIBUTE_NAME],
			LMDB_TEST_ERRORS.INVALID_ENVIRONMENT,
			'invalid env variable'
		);
		test_utils.assertErrorSync(
			search_util.startsWith,
			[transaction],
			LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED,
			'no hash attribute'
		);
		test_utils.assertErrorSync(
			search_util.startsWith,
			[transaction, 'id', 'city'],
			LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED,
			'no search_value'
		);
		test_utils.assertErrorSync(search_util.startsWith, [transaction, 'id', 'city', 'D'], undefined, 'all arguments');
	});

	it('test search on city', () => {
		let expected = [1, 4, 5];

		let results = arrayOfValues(search_util.startsWith(transaction, 'id', 'city', 'Den'));
		assert.deepEqual(results.length, 3);
		assert.deepEqual(results, expected);
	});

	it('test search on city, no hash', () => {
		let expected = [1, 4, 5];

		let results = arrayOfValues(search_util.startsWith(transaction, undefined, 'city', 'Den'));
		assert.deepEqual(results.length, 3);
		assert.deepEqual(results, expected);
	});

	it('test search on city with Denver', () => {
		let expected = [1, 4, 5];
		let results = arrayOfValues(search_util.startsWith(transaction, 'id', 'city', 'Denver'));
		assert.deepEqual(results.length, 3);
		assert.deepEqual(results, expected);
	});

	it('test search on city with Denvert', () => {
		let expected = [5];
		let results = arrayOfValues(search_util.startsWith(transaction, 'id', 'city', 'Denvert'));
		assert.deepEqual(results.length, 1);
		assert.deepEqual(results, expected);
	});

	it('test search on city with non-existent value', () => {
		let results = arrayOfValues(search_util.startsWith(transaction, 'id', 'city', 'FoCo'));
		assert.deepStrictEqual(results, []);
	});

	it('test search on attribute no exist', () => {
		let results = test_utils.assertErrorSync(
			search_util.startsWith,
			[transaction, 'id', 'fake', 'bad'],
			LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST
		);
		assert.deepStrictEqual(results, undefined);
	});

	it('test search on mush 2', () => {
		let expected = [211, 213, 214, 215];

		let results = arrayOfValues(search_util.startsWith(transaction, 'id', 'mush', 2));
		assert.deepEqual(results.length, 4);
		assert.deepEqual(results, expected);
	});
});

describe('test startsWith function reverse offset limit', () => {
	let env, transaction;
	let date_stub;
	before(async () => {
		date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
		await fs.mkdirp(BASE_TEST_PATH);
		TEST_ENVIRONMENT_NAME = uuid();
		env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
		await environment_utility.createDBI(env, 'id', false, true);
		await write_utility.insertRecords(
			env,
			HASH_ATTRIBUTE_NAME,
			test_utils.deepClone(PERSON_ATTRIBUTES),
			test_utils.deepClone(test_data)
		);
		transaction = env.useReadTransaction();
		transaction.database = env;
	});

	after(async () => {
		date_stub.restore();
		await env.close();

		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
	});

	it('test search on first_name limit 20', () => {
		let expected = [966, 884, 586, 936, 880, 278, 764, 17, 265, 805, 62, 877, 145, 739, 555, 86, 777, 650, 500, 882];

		let results = arrayOfValues(search_util.startsWith(transaction, 'id', 'first_name', 'Mar', false, 20));
		assert.deepEqual(results.length, 20);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name offset 20', () => {
		let expected = [738, 563, 106, 770, 156];

		let results = arrayOfValues(search_util.startsWith(transaction, 'id', 'first_name', 'Mar', false, undefined, 20));
		assert.deepEqual(results.length, 5);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name offset 10 limit 20', () => {
		let expected = [62, 877, 145, 739, 555, 86, 777, 650, 500, 882, 738, 563, 106, 770, 156];

		let results = arrayOfValues(search_util.startsWith(transaction, 'id', 'first_name', 'Mar', false, 20, 10));
		assert.deepEqual(results.length, 15);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name reverse', () => {
		let expected = [
			156, 770, 106, 563, 738, 882, 500, 650, 777, 86, 555, 739, 145, 877, 62, 805, 265, 17, 764, 278, 880, 936, 586,
			884, 966,
		];

		let results = arrayOfValues(search_util.startsWith(transaction, 'id', 'first_name', 'Mar', true));
		assert.deepEqual(results.length, 25);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name reverse limit 15', () => {
		let expected = [156, 770, 106, 563, 738, 882, 500, 650, 777, 86, 555, 739, 145, 877, 62];

		let results = arrayOfValues(search_util.startsWith(transaction, 'id', 'first_name', 'Mar', true, 15));
		assert.deepEqual(results.length, 15);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name reverse offset 20', () => {
		let expected = [880, 936, 586, 884, 966];

		let results = arrayOfValues(search_util.startsWith(transaction, 'id', 'first_name', 'Mar', true, undefined, 20));
		assert.deepEqual(results.length, 5);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name reverse offset 10 limit 20', () => {
		let expected = [555, 739, 145, 877, 62, 805, 265, 17, 764, 278, 880, 936, 586, 884, 966];

		let results = arrayOfValues(search_util.startsWith(transaction, 'id', 'first_name', 'Mar', true, 20, 10));
		assert.deepEqual(results.length, 15);
		assert.deepEqual(results, expected);
	});
});
