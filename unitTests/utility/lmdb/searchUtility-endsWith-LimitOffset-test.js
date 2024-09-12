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
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;
const TIMESTAMP = Date.now();

const MULTI_RECORD_ARRAY2 = [
	{ id: 1, name: 'Kyle', age: 46, city: 'Denver' },
	{ id: 2, name: 'Jerry', age: 32 },
	{ id: 3, name: 'Hank', age: 57 },
	{ id: 4, name: 'Joy', age: 44, city: 'Denver' },
	{ id: 5, name: 'Fran', age: 44, city: 'Denvertown' },
	{ id: 6, city: 'Nowhere' },
];

describe('test endsWith function', () => {
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
		transaction = env.useReadTransaction();
		transaction.database = env;
	});

	after(async () => {
		await env.close();
		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
	});

	it('test validation', () => {
		test_utils.assertErrorSync(search_util.endsWith, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
		test_utils.assertErrorSync(
			search_util.endsWith,
			[HASH_ATTRIBUTE_NAME],
			LMDB_TEST_ERRORS.INVALID_ENVIRONMENT,
			'invalid env variable'
		);
		test_utils.assertErrorSync(
			search_util.endsWith,
			[transaction],
			LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED,
			'no hash attribute'
		);
		test_utils.assertErrorSync(
			search_util.endsWith,
			[transaction, 'id', 'city'],
			LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED,
			'no search_value'
		);
		test_utils.assertErrorSync(search_util.endsWith, [transaction, 'id', 'city', 'Denver'], undefined, 'all arguments');
	});

	it('test search on city', () => {
		let expected = [1, 4];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'city', 'ver'));
		assert.deepEqual(results.length, 2);
		assert.deepEqual(results, expected);
	});

	it('test search on city, no hash', () => {
		let expected = [1, 4];
		let results = arrayOfValues(search_util.endsWith(transaction, undefined, 'city', 'ver'));
		assert.deepEqual(results.length, 2);
		assert.deepEqual(results, expected);
	});

	it('test search on city with Denver', () => {
		let expected = [1, 4];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'city', 'Denver'));
		assert.deepEqual(results.length, 2);
		assert.deepEqual(results, expected);
	});

	it('test search on city with town', () => {
		let expected = [5];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'city', 'town'));
		assert.deepEqual(results.length, 1);
		assert.deepEqual(results, expected);
	});

	it('test search on city with non-existent value', () => {
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'city', 'FoCo'));
		assert.deepStrictEqual(results, []);
	});

	it('test search on attribute no exist', () => {
		let results = test_utils.assertErrorSync(
			search_util.endsWith,
			[transaction, 'id', 'fake', 'bad'],
			LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST
		);
		assert.deepStrictEqual(results, undefined);
	});

	it('test search on hash attribute', () => {
		let expected = [1];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'id', '1'));
		assert.deepEqual(results.length, 1);
		assert.deepEqual(results, expected);
	});
});

describe('test endsWith function reverse limit offset', () => {
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

	it('test search on id limit 20', () => {
		let expected = [1, 11, 21, 31, 41, 51, 61, 71, 81, 91, 101, 111, 121, 131, 141, 151, 161, 171, 181, 191];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'id', 1, false, 20));
		assert.deepEqual(results.length, 20);
		assert.deepEqual(results, expected);
	});

	it('test search on id offset 20', () => {
		let expected = [
			201, 211, 221, 231, 241, 251, 261, 271, 281, 291, 301, 311, 321, 331, 341, 351, 361, 371, 381, 391, 401, 411, 421,
			431, 441, 451, 461, 471, 481, 491, 501, 511, 521, 531, 541, 551, 561, 571, 581, 591, 601, 611, 621, 631, 641, 651,
			661, 671, 681, 691, 701, 711, 721, 731, 741, 751, 761, 771, 781, 791, 801, 811, 821, 831, 841, 851, 861, 871, 881,
			891, 901, 911, 921, 931, 941, 951, 961, 971, 981, 991,
		];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'id', 1, false, undefined, 20));
		assert.deepEqual(results.length, 80, `expected results index 0 to be 80 but got ${results.length}`);
		assert.deepEqual(results, expected, 'results does not match expected result');
	});

	it('test search on id limit 20 offset 20', () => {
		let expected = [201, 211, 221, 231, 241, 251, 261, 271, 281, 291, 301, 311, 321, 331, 341, 351, 361, 371, 381, 391];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'id', 1, false, 20, 20));
		assert.deepEqual(results.length, 20);
		assert.deepEqual(results, expected);
	});

	it('test search on id reverse', () => {
		let expected = [
			991, 981, 971, 961, 951, 941, 931, 921, 911, 901, 891, 881, 871, 861, 851, 841, 831, 821, 811, 801, 791, 781, 771,
			761, 751, 741, 731, 721, 711, 701, 691, 681, 671, 661, 651, 641, 631, 621, 611, 601, 591, 581, 571, 561, 551, 541,
			531, 521, 511, 501, 491, 481, 471, 461, 451, 441, 431, 421, 411, 401, 391, 381, 371, 361, 351, 341, 331, 321, 311,
			301, 291, 281, 271, 261, 251, 241, 231, 221, 211, 201, 191, 181, 171, 161, 151, 141, 131, 121, 111, 101, 91, 81,
			71, 61, 51, 41, 31, 21, 11, 1,
		];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'id', 1, true));
		assert.deepEqual(results.length, 100);
		assert.deepEqual(results, expected);
	});

	it('test search on id reverse limit 20', () => {
		let expected = [991, 981, 971, 961, 951, 941, 931, 921, 911, 901, 891, 881, 871, 861, 851, 841, 831, 821, 811, 801];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'id', 1, true, 20));
		assert.deepEqual(results.length, 20);
		assert.deepEqual(results, expected);
	});

	it('test search on id reverse offset 20', () => {
		let expected = [
			791, 781, 771, 761, 751, 741, 731, 721, 711, 701, 691, 681, 671, 661, 651, 641, 631, 621, 611, 601, 591, 581, 571,
			561, 551, 541, 531, 521, 511, 501, 491, 481, 471, 461, 451, 441, 431, 421, 411, 401, 391, 381, 371, 361, 351, 341,
			331, 321, 311, 301, 291, 281, 271, 261, 251, 241, 231, 221, 211, 201, 191, 181, 171, 161, 151, 141, 131, 121, 111,
			101, 91, 81, 71, 61, 51, 41, 31, 21, 11, 1,
		];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'id', 1, true, undefined, 20));
		assert.deepEqual(results.length, 80);
		assert.deepEqual(results, expected);
	});

	it('test search on id reverse limit 20 offset 20', () => {
		let expected = [791, 781, 771, 761, 751, 741, 731, 721, 711, 701, 691, 681, 671, 661, 651, 641, 631, 621, 611, 601];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'id', 1, true, 20, 20));
		assert.deepEqual(results.length, 20);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name limit 10', () => {
		let expected = [669, 270, 545, 898, 876, 621, 795, 538, 19, 301];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'first_name', 'ia', false, 10));
		assert.deepEqual(results.length, 10);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name limit 10 offset 10', () => {
		let expected = [625, 968, 268, 685, 425, 871, 936, 62, 692, 450];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'first_name', 'ia', false, 10, 10));
		assert.deepEqual(results.length, 10);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name reverse', () => {
		let expected = [
			467, 901, 314, 186, 508, 922, 151, 450, 692, 62, 936, 871, 425, 685, 268, 968, 625, 301, 19, 538, 795, 621, 876,
			898, 545, 270, 669,
		];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'first_name', 'ia', true));
		assert.deepEqual(results.length, 27);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name reverse limit 10', () => {
		let expected = [467, 901, 314, 186, 508, 922, 151, 450, 692, 62];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'first_name', 'ia', true, 10));
		assert.deepEqual(results.length, 10);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name reverse offset 10', () => {
		let expected = [936, 871, 425, 685, 268, 968, 625, 301, 19, 538, 795, 621, 876, 898, 545, 270, 669];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'first_name', 'ia', true, undefined, 10));
		assert.deepEqual(results.length, 17);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name reverse limit 10 offset 10', () => {
		let expected = [936, 871, 425, 685, 268, 968, 625, 301, 19, 538];
		let results = arrayOfValues(search_util.endsWith(transaction, 'id', 'first_name', 'ia', true, 10, 10));
		assert.deepEqual(results.length, 10);
		assert.deepEqual(results, expected);
	});
});
