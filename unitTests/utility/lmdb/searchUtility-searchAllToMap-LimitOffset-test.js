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

const TIMESTAMP = Date.now();

describe('test searchAllToMap function', () => {
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

	it('searchAllToMap rows limit 100', () => {
		let rows = test_utils.assertErrorSync(
			search_util.searchAllToMap,
			[transaction, HASH_ATTRIBUTE_NAME, PERSON_ATTRIBUTES, false, 100],
			undefined,
			'search'
		);

		let expected = new Map();
		for (let x = 0; x < 100; x++) {
			expected.set(x, test_utils.assignObjecttoNullObject(test_data[x]));
		}

		assert.deepStrictEqual(rows, expected);
	});

	it('searchAllToMap rows limit 20 offset 100', () => {
		let rows = test_utils.assertErrorSync(
			search_util.searchAllToMap,
			[transaction, HASH_ATTRIBUTE_NAME, PERSON_ATTRIBUTES, false, 20, 100],
			undefined,
			'search'
		);

		let expected = new Map();
		for (let x = 100; x < 120; x++) {
			expected.set(x, test_utils.assignObjecttoNullObject(test_data[x]));
		}

		assert.deepStrictEqual(rows, expected);
	});

	it('searchAllToMap rows reverse limit 100', () => {
		let rows = test_utils.assertErrorSync(
			search_util.searchAllToMap,
			[transaction, HASH_ATTRIBUTE_NAME, PERSON_ATTRIBUTES, true, 100],
			undefined,
			'search'
		);

		let expected = new Map();
		for (let x = 999; x >= 900; x--) {
			expected.set(x, test_utils.assignObjecttoNullObject(test_data[x]));
		}

		assert.deepStrictEqual(rows, expected);
	});

	it('searchAllToMap rows reverse limit 20 offset 100', () => {
		let rows = test_utils.assertErrorSync(
			search_util.searchAllToMap,
			[transaction, HASH_ATTRIBUTE_NAME, PERSON_ATTRIBUTES, true, 20, 100],
			undefined,
			'search'
		);

		let expected = new Map();
		for (let x = 899; x >= 880; x--) {
			expected.set(x, test_utils.assignObjecttoNullObject(test_data[x]));
		}

		assert.deepStrictEqual(rows, expected);
	});
});
