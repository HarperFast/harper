'use strict';

const rewire = require('rewire');
const delete_utility = require('../../../utility/lmdb/deleteUtility');
const search_util = require('../../../utility/lmdb/searchUtility');
const common = require('../../../utility/lmdb/commonUtility');
const fs = require('fs-extra');
const environment_utility = rewire('../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../utility/lmdb/writeUtility');
const DeleteRecordsResponseObject = require('../../../utility/lmdb/DeleteRecordsResponseObject');
const test_utils = require('../../test_utils');
const path = require('path');
const assert = require('assert');
const sinon = require('sinon');
const uuid = require('uuid').v4;
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;

const BASE_TEST_PATH = path.join(test_utils.getMockLMDBPath(), 'lmdbTest');
let TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const All_ATTRIBUTES = ['id', 'name', 'age', 'city', 'text'];

const MULTI_RECORD_ARRAY = [
	{ id: 1, name: 'Kyle', age: 46, city: 'Denver' },
	{ id: 2, name: 'Jerry', age: 32 },
	{ id: 3, name: 'Hank', age: 57 },
	{ id: 4, name: 'Joy', age: 44, city: 'Denver' },
	{ id: 5, name: 'Fran', age: 44, city: 'Denvertown' },
	{
		id: 6,
		text: "Occupy messenger bag microdosing yr, kale chips neutra la croix VHS ugh wayfarers street art. Ethical cronut whatever, cold-pressed viral post-ironic man bun swag marfa green juice. Knausgaard gluten-free selvage ethical subway tile sartorial man bun butcher selfies raclette paleo. Fam brunch plaid woke authentic dreamcatcher hot chicken quinoa gochujang slow-carb selfies keytar PBR&B street art pinterest. Narwhal tote bag glossier paleo cronut salvia cloud bread craft beer butcher meditation fingerstache hella migas 8-bit messenger bag. Tattooed schlitz palo santo gluten-free, wayfarers tumeric squid. Hella keytar thundercats chambray, occupy iPhone paleo slow-carb jianbing everyday carry 90's distillery polaroid fanny pack. Kombucha cray PBR&B shoreditch 8-bit, adaptogen vinyl swag meditation 3 wolf moon. Selvage art party retro kitsch pour-over iPhone street art celiac etsy cred cliche gastropub. Kombucha migas marfa listicle cliche. Godard kombucha ennui lumbersexual, austin pop-up raclette retro. Man braid kale chips pitchfork, tote bag hoodie poke mumblecore. Bitters shoreditch tbh everyday carry keffiyeh raw denim kale chips.",
	},
];

const MULTI_RECORD_ARRAY_COMPARE = [
	{ id: 1, name: 'Kyle', age: 46, city: 'Denver' },
	{ id: 2, name: 'Jerry', age: 32 },
	{ id: 3, name: 'Hank', age: 57 },
	{ id: 4, name: 'Joy', age: 44, city: 'Denver' },
	{ id: 5, name: 'Fran', age: 44, city: 'Denvertown' },
	{
		id: 6,
		text: "Occupy messenger bag microdosing yr, kale chips neutra la croix VHS ugh wayfarers street art. Ethical cronut whatever, cold-pressed viral post-ironic man bun swag marfa green juice. Knausgaard gluten-free selvage ethical subway tile sartorial man bun butcher selfies raclette paleo. Fam brunch plaid woke authentic dreamcatcher hot chicken quinoa gochujang slow-carb selfies keytar PBR&B street art pinterest. Narwhal tote bag glossier paleo cronut salvia cloud bread craft beer butcher meditation fingerstache hella migas 8-bit messenger bag. Tattooed schlitz palo santo gluten-free, wayfarers tumeric squid. Hella keytar thundercats chambray, occupy iPhone paleo slow-carb jianbing everyday carry 90's distillery polaroid fanny pack. Kombucha cray PBR&B shoreditch 8-bit, adaptogen vinyl swag meditation 3 wolf moon. Selvage art party retro kitsch pour-over iPhone street art celiac etsy cred cliche gastropub. Kombucha migas marfa listicle cliche. Godard kombucha ennui lumbersexual, austin pop-up raclette retro. Man braid kale chips pitchfork, tote bag hoodie poke mumblecore. Bitters shoreditch tbh everyday carry keffiyeh raw denim kale chips.",
	},
];

const IDS = [1, 2, 3, 4, 5, 6];

const TXN_TIMESTAMP = common.getNextMonotonicTime();
const sandbox = sinon.createSandbox();

describe('Test deleteUtility', () => {
	let env, transaction;

	let get_monotonic_time_stub;

	beforeEach(async () => {
		get_monotonic_time_stub = sandbox.stub(common, 'getNextMonotonicTime').returns(TXN_TIMESTAMP);
		global.lmdb_map = undefined;

		await fs.remove(test_utils.getMockLMDBPath());
		await fs.mkdirp(BASE_TEST_PATH);
		TEST_ENVIRONMENT_NAME = uuid();
		env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
		let clone_records = test_utils.deepClone(MULTI_RECORD_ARRAY);
		let rez = await write_utility.insertRecords(
			env,
			HASH_ATTRIBUTE_NAME,
			test_utils.deepClone(All_ATTRIBUTES),
			MULTI_RECORD_ARRAY
		);
	});

	afterEach(async () => {
		await env.close();
		global.lmdb_map = undefined;
		await fs.remove(BASE_TEST_PATH);
		get_monotonic_time_stub.restore();
	});

	describe('Test deleteRecords function', () => {
		it('test validation', async () => {
			await test_utils.assertErrorAsync(delete_utility.deleteRecords, [], LMDB_TEST_ERRORS.ENV_REQUIRED);
			await test_utils.assertErrorAsync(
				delete_utility.deleteRecords,
				[HASH_ATTRIBUTE_NAME],
				LMDB_TEST_ERRORS.INVALID_ENVIRONMENT
			);
			await test_utils.assertErrorAsync(delete_utility.deleteRecords, [env], LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED);
			await test_utils.assertErrorAsync(
				delete_utility.deleteRecords,
				[env, HASH_ATTRIBUTE_NAME],
				LMDB_TEST_ERRORS.IDS_REQUIRED
			);
			await test_utils.assertErrorAsync(
				delete_utility.deleteRecords,
				[env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME],
				LMDB_TEST_ERRORS.IDS_MUST_BE_ITERABLE
			);
			await test_utils.assertErrorAsync(delete_utility.deleteRecords, [env, HASH_ATTRIBUTE_NAME, []], undefined);
		});

		it('delete all records', async () => {
			let expected_compare = [];
			MULTI_RECORD_ARRAY_COMPARE.forEach((compare) => {
				expected_compare.push({ __updatedtime__: TXN_TIMESTAMP, __createdtime__: TXN_TIMESTAMP, ...compare });
			});

			let records = [];
			IDS.forEach((id) => {
				let record = env.dbis[HASH_ATTRIBUTE_NAME].get(id);
				if (record) {
					records.push(record);
				}
			});
			assert.deepStrictEqual(records, expected_compare);

			let orig_records = test_utils.deepClone(records);
			let expected_delete_results = new DeleteRecordsResponseObject(
				[1, 2, 3, 4, 5, 6],
				[],
				TXN_TIMESTAMP,
				orig_records
			);

			let results = await test_utils.assertErrorAsync(
				delete_utility.deleteRecords,
				[env, HASH_ATTRIBUTE_NAME, IDS],
				undefined
			);
			assert.deepStrictEqual(results, expected_delete_results);

			//assert all indices have been cleared
			records = [];
			IDS.forEach((id) => {
				let record = env.dbis[HASH_ATTRIBUTE_NAME].get(id);
				if (record) {
					records.push(record);
				}
			});
			assert.deepStrictEqual(records, []);

			All_ATTRIBUTES.forEach((attribute) => {
				let results = iterateIndex(env, attribute);
				assert.deepStrictEqual(results, {});
			});
		});

		it('delete some records', async () => {
			let some_ids = [2, 4];
			let some_record_compare = [
				{
					age: 32,
					id: 2,
					name: 'Jerry',
					__createdtime__: TXN_TIMESTAMP,
					__updatedtime__: TXN_TIMESTAMP,
				},
				{
					age: 44,
					city: 'Denver',
					id: 4,
					name: 'Joy',
					__createdtime__: TXN_TIMESTAMP,
					__updatedtime__: TXN_TIMESTAMP,
				},
			];

			let records = [];
			some_ids.forEach((id) => {
				let record = env.dbis[HASH_ATTRIBUTE_NAME].get(id);
				if (record) {
					records.push(record);
				}
			});

			assert.deepStrictEqual(records, some_record_compare);

			let orig_records = test_utils.deepClone(records);
			let expected_delete_results = new DeleteRecordsResponseObject([2, 4], [], TXN_TIMESTAMP, orig_records);

			let delete_results = await test_utils.assertErrorAsync(
				delete_utility.deleteRecords,
				[env, HASH_ATTRIBUTE_NAME, some_ids],
				undefined
			);
			assert.deepStrictEqual(delete_results, expected_delete_results);

			//assert can't find the rows
			records = [];
			some_ids.forEach((id) => {
				let record = env.dbis[HASH_ATTRIBUTE_NAME].get(id);
				if (record) {
					records.push(record);
				}
			});
			assert.deepStrictEqual(records, []);

			//assert indices don't have deleted record entries
			let iterate_results = { 44: [5], 46: [1], 57: [3] };
			let results = iterateIndex(env, 'age');
			assert.deepStrictEqual(results, iterate_results);

			iterate_results = { Denver: [1], Denvertown: [5] };
			results = iterateIndex(env, 'city');
			assert.deepStrictEqual(results, iterate_results);

			iterate_results = { Fran: [5], Hank: [3], Kyle: [1] };
			results = iterateIndex(env, 'name');
			assert.deepStrictEqual(results, iterate_results);
		});

		it('delete record with long text', async () => {
			let some_ids = [6];
			let some_record_compare = [test_utils.deepClone(MULTI_RECORD_ARRAY[5])];

			let records = [];
			some_ids.forEach((id) => {
				let record = env.dbis[HASH_ATTRIBUTE_NAME].get(id);
				if (record) {
					records.push(record);
				}
			});

			assert.deepStrictEqual(records, some_record_compare);

			let orig_records = test_utils.deepClone(records);
			let expected_delete_results = new DeleteRecordsResponseObject([6], [], TXN_TIMESTAMP, orig_records);

			let delete_results = await test_utils.assertErrorAsync(
				delete_utility.deleteRecords,
				[env, HASH_ATTRIBUTE_NAME, some_ids],
				undefined
			);
			assert.deepStrictEqual(delete_results, expected_delete_results);

			//assert can't find the rows
			records = [];
			some_ids.forEach((id) => {
				let record = env.dbis[HASH_ATTRIBUTE_NAME].get(id);
				if (record) {
					records.push(record);
				}
			});
			assert.deepStrictEqual(records, []);

			//assert indices don't have deleted record entries
			let iterate_results = { 32: [2], 44: [4, 5], 46: [1], 57: [3] };
			let results = iterateIndex(env, 'age');
			assert.deepStrictEqual(results, iterate_results);

			iterate_results = { Denver: [1, 4], Denvertown: [5] };
			results = iterateIndex(env, 'city');
			assert.deepStrictEqual(results, iterate_results);

			iterate_results = { Fran: [5], Hank: [3], Jerry: [2], Joy: [4], Kyle: [1] };
			results = iterateIndex(env, 'name');
			assert.deepStrictEqual(results, iterate_results);

			results = iterateIndex(env, '__createdtime__');

			Object.keys(results).forEach((key) => {
				assert.deepStrictEqual(results[key].indexOf('6'), -1);
			});
		});

		it('delete record that does not exist', async () => {
			let some_ids = [2444444];

			let results = await test_utils.assertErrorAsync(
				delete_utility.deleteRecords,
				[env, HASH_ATTRIBUTE_NAME, some_ids],
				undefined
			);
			let expect_results = new DeleteRecordsResponseObject([], [2444444], TXN_TIMESTAMP, []);
			assert.deepStrictEqual(results, expect_results);
		});
	});
});

function iterateIndex(env, attribute) {
	let records = {};
	for (let { key, value } of env.dbis[attribute].getRange({ start: false })) {
		if (!records[key]) {
			records[key] = [];
		}
		records[key].push(value);
	}
	return records;
}
