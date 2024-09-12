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

const MULTI_RECORD_ARRAY = [
	{ id: 1, name: 'Kyle', age: 46, city: ['Athens', 'Denver'] },
	{ id: 2, name: 'Jerry', age: 32 },
	{ id: 3, name: 'Hank', age: 57 },
	{ id: 4, name: 'Joy', age: 44, city: 'Denver' },
];

const TIMESTAMP = Date.now();

describe('test equals function', () => {
	let env, transaction;
	before(async () => {
		global.lmdb_map = undefined;
		await fs.remove(test_utils.getMockLMDBPath());
		await fs.mkdirp(BASE_TEST_PATH);
		TEST_ENVIRONMENT_NAME = uuid();
		env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
		await environment_utility.createDBI(env, 'id', false, true);
		await environment_utility.createDBI(env, 'age', true, false);
		await write_utility.insertRecords(
			env,
			HASH_ATTRIBUTE_NAME,
			test_utils.deepClone(All_ATTRIBUTES),
			MULTI_RECORD_ARRAY
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
		test_utils.assertErrorSync(search_util.equals, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
		test_utils.assertErrorSync(
			search_util.equals,
			[HASH_ATTRIBUTE_NAME],
			LMDB_TEST_ERRORS.INVALID_ENVIRONMENT,
			'invalid env variable'
		);
		test_utils.assertErrorSync(
			search_util.equals,
			[transaction],
			LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED,
			'no hash attribute'
		);
		test_utils.assertErrorSync(
			search_util.equals,
			[transaction, 'id', 'city'],
			LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED,
			'no search_value'
		);
		test_utils.assertErrorSync(search_util.equals, [transaction, 'id', 'city', 'Denver'], undefined, 'all arguments');
	});

	it('test search on city', () => {
		let expected = [1, 4];

		let results = arrayOfValues(search_util.equals(transaction, 'id', 'city', 'Denver'));
		assert.deepEqual(results.length, 2);
		assert.deepEqual(results, expected);
	});

	it('test search on city, no hash', () => {
		let expected = [1, 4];
		let results = arrayOfValues(search_util.equals(transaction, undefined, 'city', 'Denver'));
		assert.deepEqual(results.length, 2);
		assert.deepEqual(results, expected);
	});

	it('test search on city with only partial value', () => {
		let results = arrayOfValues(search_util.equals(transaction, 'id', 'city', 'Den'));
		assert.deepStrictEqual(results, []);
	});

	it('test search on attribute no exist', () => {
		let results = test_utils.assertErrorSync(
			search_util.equals,
			[transaction, 'id', 'fake', 'bad'],
			LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST
		);
		assert.deepStrictEqual(results, undefined);
	});

	it('test search on age (number attribute)', () => {
		let expected = [1];

		let results = arrayOfValues(search_util.equals(transaction, 'id', 'age', 46));
		assert.deepEqual(results.length, 1);
		assert.deepEqual(results, expected);
	});

	it("test search on age (number attribute) value doesn't exist", () => {
		let results = arrayOfValues(search_util.equals(transaction, 'id', 'age', 100));
		assert.deepStrictEqual(results, []);
	});

	it('test search on hash attribute (id)', () => {
		let expected = [1];
		let results = arrayOfValues(search_util.equals(transaction, 'id', 'id', 1));
		assert.deepEqual(results.length, 1);
		assert.deepEqual(results, expected);
	});

	it("test search on hash attribute (id), value doesn't exist", () => {
		let results = arrayOfValues(search_util.equals(transaction, 'id', 'id', 10000));
		assert.deepStrictEqual(results, []);
	});
});

describe('test equals function reverse limit offset', () => {
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

	it('test search on state limit 10', () => {
		let expected = [58, 60, 83, 88, 172, 224, 229, 330, 384, 418];

		let results = arrayOfValues(search_util.equals(transaction, 'id', 'state', 'CO', false, 10));
		assert.deepEqual(results.length, 10);
		assert.deepEqual(results, expected);
	});

	it('test search on state offset 10', () => {
		let expected = [481, 521, 611, 644, 658, 701, 943, 946, 967];

		let results = arrayOfValues(search_util.equals(transaction, 'id', 'state', 'CO', false, undefined, 10));
		assert.deepEqual(results.length, 9);
		assert.deepEqual(results, expected);
	});

	it('test search on state, limit 1000', () => {
		let expected = [58, 60, 83, 88, 172, 224, 229, 330, 384, 418, 481, 521, 611, 644, 658, 701, 943, 946, 967];

		let results = arrayOfValues(search_util.equals(transaction, undefined, 'state', 'CO', false, 1000));
		assert.deepEqual(results.length, 19);
		assert.deepEqual(results, expected);
	});

	it('test search on state, offset 10 limit 5', () => {
		let expected = [481, 521, 611, 644, 658];

		let results = arrayOfValues(search_util.equals(transaction, undefined, 'state', 'CO', false, 5, 10));
		assert.deepEqual(results.length, 5);
		assert.deepEqual(results, expected);
	});

	it('test search on state, offset 1000 limit 5', () => {
		let results = arrayOfValues(search_util.equals(transaction, undefined, 'state', 'CO', false, 5, 1000));
		assert.deepEqual(results, []);
	});

	it('test search on state reverse', () => {
		let expected = [967, 946, 943, 701, 658, 644, 611, 521, 481, 418, 384, 330, 229, 224, 172, 88, 83, 60, 58];

		let results = arrayOfValues(search_util.equals(transaction, 'id', 'state', 'CO', true));
		assert.deepEqual(results.length, 19);
		assert.deepEqual(results, expected);
	});

	it('test search on state reverse limit 10', () => {
		let expected = [967, 946, 943, 701, 658, 644, 611, 521, 481, 418];

		let results = arrayOfValues(search_util.equals(transaction, 'id', 'state', 'CO', true, 10));
		assert.deepEqual(results.length, 10);
		assert.deepEqual(results, expected);
	});

	it('test search on state reverse offset 10', () => {
		let expected = [384, 330, 229, 224, 172, 88, 83, 60, 58];

		let results = arrayOfValues(search_util.equals(transaction, 'id', 'state', 'CO', true, undefined, 10));
		assert.deepEqual(results.length, 9);
		assert.deepEqual(results, expected);
	});

	it('test search on state, reverse, limit 1000', () => {
		let expected = [967, 946, 943, 701, 658, 644, 611, 521, 481, 418, 384, 330, 229, 224, 172, 88, 83, 60, 58];

		let results = arrayOfValues(search_util.equals(transaction, undefined, 'state', 'CO', true, 1000));
		assert.deepEqual(results.length, 19);
		assert.deepEqual(results, expected);
	});

	it('test search on state, reverse offset 10 limit 5', () => {
		let expected = [384, 330, 229, 224, 172];

		let results = arrayOfValues(search_util.equals(transaction, undefined, 'state', 'CO', true, 5, 10));
		assert.deepEqual(results.length, 5);
		assert.deepEqual(results, expected);
	});

	it('test search on state, reverse offset 1000 limit 5', () => {
		let results = arrayOfValues(search_util.equals(transaction, undefined, 'state', 'CO', true, 5, 1000));
		assert.deepEqual(results, []);
	});
});
