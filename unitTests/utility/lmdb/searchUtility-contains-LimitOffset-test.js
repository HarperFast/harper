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

describe('test contains function', () => {
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
		test_utils.assertErrorSync(search_util.contains, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'test no args');
		test_utils.assertErrorSync(
			search_util.contains,
			[HASH_ATTRIBUTE_NAME],
			LMDB_TEST_ERRORS.INVALID_ENVIRONMENT,
			'invalid env variable'
		);
		test_utils.assertErrorSync(
			search_util.contains,
			[transaction],
			LMDB_TEST_ERRORS.ATTRIBUTE_REQUIRED,
			'no hash attribute'
		);
		test_utils.assertErrorSync(
			search_util.contains,
			[transaction, 'id', 'city'],
			LMDB_TEST_ERRORS.SEARCH_VALUE_REQUIRED,
			'no search_value'
		);
		test_utils.assertErrorSync(search_util.contains, [transaction, 'id', 'city', 'Denver'], undefined, 'all arguments');
	});

	it('test search on city', () => {
		let expected = [1, 4, 5];
		let results = arrayOfValues(search_util.contains(transaction, 'id', 'city', 'ver'));
		assert.deepEqual(results.length, 3);
		assert.deepEqual(results, expected);
	});

	it('test search on city with Denver', () => {
		let expected = [1, 4, 5];
		let results = arrayOfValues(search_util.contains(transaction, 'id', 'city', 'Denver'));
		assert.deepEqual(results.length, 3);
		assert.deepEqual(results, expected);
	});

	it('test search on city with town', () => {
		let expected = [5];
		let results = arrayOfValues(search_util.contains(transaction, 'id', 'city', 'town'));
		assert.deepEqual(results.length, 1);
		assert.deepEqual(results, expected);
	});

	it('test search on city with non-existent value', () => {
		let results = arrayOfValues(search_util.contains(transaction, 'id', 'city', 'FoCo'));
		assert.deepStrictEqual(results, []);
	});

	it('test search on attribute no exist', () => {
		let results = test_utils.assertErrorSync(
			search_util.contains,
			[transaction, 'id', 'fake', 'bad'],
			LMDB_TEST_ERRORS.DBI_DOES_NOT_EXIST
		);
		assert.deepStrictEqual(results, undefined);
	});

	it('test search on id with 3', () => {
		let expected = [3];
		let results = arrayOfValues(search_util.contains(transaction, 'id', 'id', 3));
		assert.deepEqual(results.length, 1);
		assert.deepEqual(results, expected);
	});
});

describe('test contains function reverse limit offset', () => {
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
		let expected = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'id', '0', false, 20));
		assert.deepEqual(results.length, 20);
		assert.deepEqual(results, expected);
	});

	it('test search on id offset 20', () => {
		let expected = [
			110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 220, 230, 240,
			250, 260, 270, 280, 290, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 320, 330, 340, 350, 360, 370, 380,
			390, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 420, 430, 440, 450, 460, 470, 480, 490, 500, 501, 502,
			503, 504, 505, 506, 507, 508, 509, 510, 520, 530, 540, 550, 560, 570, 580, 590, 600, 601, 602, 603, 604, 605, 606,
			607, 608, 609, 610, 620, 630, 640, 650, 660, 670, 680, 690, 700, 701, 702, 703, 704, 705, 706, 707, 708, 709, 710,
			720, 730, 740, 750, 760, 770, 780, 790, 800, 801, 802, 803, 804, 805, 806, 807, 808, 809, 810, 820, 830, 840, 850,
			860, 870, 880, 890, 900, 901, 902, 903, 904, 905, 906, 907, 908, 909, 910, 920, 930, 940, 950, 960, 970, 980, 990,
		];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'id', '0', false, undefined, 20));
		assert.deepEqual(results.length, 161);
		assert.deepEqual(results, expected);
	});

	it('test search on id limit 20 offset 20', () => {
		let expected = [110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'id', '0', false, 20, 20));
		assert.deepEqual(results.length, 20);
		assert.deepEqual(results, expected);
	});

	it('test search on id reverse', () => {
		let expected = [
			990, 980, 970, 960, 950, 940, 930, 920, 910, 909, 908, 907, 906, 905, 904, 903, 902, 901, 900, 890, 880, 870, 860,
			850, 840, 830, 820, 810, 809, 808, 807, 806, 805, 804, 803, 802, 801, 800, 790, 780, 770, 760, 750, 740, 730, 720,
			710, 709, 708, 707, 706, 705, 704, 703, 702, 701, 700, 690, 680, 670, 660, 650, 640, 630, 620, 610, 609, 608, 607,
			606, 605, 604, 603, 602, 601, 600, 590, 580, 570, 560, 550, 540, 530, 520, 510, 509, 508, 507, 506, 505, 504, 503,
			502, 501, 500, 490, 480, 470, 460, 450, 440, 430, 420, 410, 409, 408, 407, 406, 405, 404, 403, 402, 401, 400, 390,
			380, 370, 360, 350, 340, 330, 320, 310, 309, 308, 307, 306, 305, 304, 303, 302, 301, 300, 290, 280, 270, 260, 250,
			240, 230, 220, 210, 209, 208, 207, 206, 205, 204, 203, 202, 201, 200, 190, 180, 170, 160, 150, 140, 130, 120, 110,
			109, 108, 107, 106, 105, 104, 103, 102, 101, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0,
		];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'id', '0', true));
		assert.deepEqual(results.length, 181);
		assert.deepEqual(results, expected);
	});

	it('test search on id reverse limit 20', () => {
		let expected = [990, 980, 970, 960, 950, 940, 930, 920, 910, 909, 908, 907, 906, 905, 904, 903, 902, 901, 900, 890];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'id', '0', true, 20));
		assert.deepEqual(results.length, 20);
		assert.deepEqual(results, expected);
	});

	it('test search on id reverse offset 20', () => {
		let expected = [
			880, 870, 860, 850, 840, 830, 820, 810, 809, 808, 807, 806, 805, 804, 803, 802, 801, 800, 790, 780, 770, 760, 750,
			740, 730, 720, 710, 709, 708, 707, 706, 705, 704, 703, 702, 701, 700, 690, 680, 670, 660, 650, 640, 630, 620, 610,
			609, 608, 607, 606, 605, 604, 603, 602, 601, 600, 590, 580, 570, 560, 550, 540, 530, 520, 510, 509, 508, 507, 506,
			505, 504, 503, 502, 501, 500, 490, 480, 470, 460, 450, 440, 430, 420, 410, 409, 408, 407, 406, 405, 404, 403, 402,
			401, 400, 390, 380, 370, 360, 350, 340, 330, 320, 310, 309, 308, 307, 306, 305, 304, 303, 302, 301, 300, 290, 280,
			270, 260, 250, 240, 230, 220, 210, 209, 208, 207, 206, 205, 204, 203, 202, 201, 200, 190, 180, 170, 160, 150, 140,
			130, 120, 110, 109, 108, 107, 106, 105, 104, 103, 102, 101, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0,
		];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'id', '0', true, undefined, 20));
		assert.deepEqual(results.length, 161);
		assert.deepEqual(results, expected);
	});

	it('test search on id reverse limit 20 offset 20', () => {
		let expected = [880, 870, 860, 850, 840, 830, 820, 810, 809, 808, 807, 806, 805, 804, 803, 802, 801, 800, 790, 780];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'id', '0', true, 20, 20));
		assert.deepEqual(results.length, 20);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name limit 20', () => {
		let expected = [518, 662, 523, 858, 75, 679, 740, 127, 646, 790, 161, 612, 707, 935, 465, 14, 306, 979, 175, 230];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'first_name', 'er', false, 20));
		assert.deepEqual(results.length, 20);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name offset 20', () => {
		let expected = [
			349, 108, 475, 908, 809, 21, 223, 199, 92, 376, 451, 191, 741, 166, 382, 51, 328, 655, 561, 939, 924, 204, 252,
			584, 491, 10, 726, 46, 49, 424, 0, 556, 712, 83, 965, 697, 371, 285, 28, 453, 136, 686, 146, 546, 961, 560, 74,
			218, 581, 745, 417, 282, 174, 653, 67, 851, 423, 830, 868, 779, 864, 95, 461, 314, 938, 291, 516, 848, 570, 470,
			18, 645, 393, 398,
		];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'first_name', 'er', false, undefined, 20));
		assert.deepEqual(results.length, 74);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name limit 20 offset 20', () => {
		let expected = [349, 108, 475, 908, 809, 21, 223, 199, 92, 376, 451, 191, 741, 166, 382, 51, 328, 655, 561, 939];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'first_name', 'er', false, 20, 20));
		assert.deepEqual(results.length, 20);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name reverse', () => {
		let expected = [
			393, 398, 645, 18, 470, 570, 848, 516, 291, 938, 314, 95, 461, 779, 864, 868, 830, 423, 67, 851, 653, 174, 282,
			417, 745, 581, 218, 74, 560, 546, 961, 146, 136, 686, 28, 453, 285, 371, 697, 965, 83, 556, 712, 0, 46, 49, 424,
			10, 726, 491, 584, 204, 252, 924, 939, 561, 655, 328, 51, 382, 166, 741, 191, 92, 376, 451, 199, 21, 223, 809,
			108, 475, 908, 349, 230, 175, 979, 14, 306, 465, 935, 707, 612, 161, 646, 790, 127, 740, 679, 75, 858, 523, 662,
			518,
		];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'first_name', 'er', true));
		assert.deepEqual(results.length, 94);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name reverse limit 20', () => {
		let expected = [393, 398, 645, 18, 470, 570, 848, 516, 291, 938, 314, 95, 461, 779, 864, 868, 830, 423, 67, 851];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'first_name', 'er', true, 20));
		assert.deepEqual(results.length, 20);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name reverse offset 20', () => {
		let expected = [
			653, 174, 282, 417, 745, 581, 218, 74, 560, 546, 961, 146, 136, 686, 28, 453, 285, 371, 697, 965, 83, 556, 712, 0,
			46, 49, 424, 10, 726, 491, 584, 204, 252, 924, 939, 561, 655, 328, 51, 382, 166, 741, 191, 92, 376, 451, 199, 21,
			223, 809, 108, 475, 908, 349, 230, 175, 979, 14, 306, 465, 935, 707, 612, 161, 646, 790, 127, 740, 679, 75, 858,
			523, 662, 518,
		];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'first_name', 'er', true, undefined, 20));
		assert.deepEqual(results.length, 74);
		assert.deepEqual(results, expected);
	});

	it('test search on first_name reverse offset 20 limit 20', () => {
		let expected = [653, 174, 282, 417, 745, 581, 218, 74, 560, 546, 961, 146, 136, 686, 28, 453, 285, 371, 697, 965];

		let results = arrayOfValues(search_util.contains(transaction, 'id', 'first_name', 'er', true, 20, 20));
		assert.deepEqual(results.length, 20);
		assert.deepEqual(results, expected);
	});
});
