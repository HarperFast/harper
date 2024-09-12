'use strict';

const rewire = require('rewire');
const common = require('../../../utility/lmdb/commonUtility');
const write_utility = rewire('../../../utility/lmdb/writeUtility');
const environment_utility = rewire('../../../utility/lmdb/environmentUtility');
const rw_write_validator = write_utility.__get__('validateWrite');
const search_util = require('../../../utility/lmdb/searchUtility');
const assert = require('assert');
const path = require('path');
const test_utils = require('../../test_utils');
const fs = require('fs-extra');
const LMDB_TEST_ERRORS = require('../../commonTestErrors').LMDB_ERRORS_ENUM;
const sinon = require('sinon');
const alasql = require('alasql');
const uuid = require('uuid').v4;
const hdb_terms = require('../../../utility/hdbTerms');
const InsertRecordsResponseObject = require('../../../utility/lmdb/InsertRecordsResponseObject');
const UpdateRecordsResponseObject = require('../../../utility/lmdb/UpdateRecordsResponseObject');
const UpsertRecordsResponseObject = require('../../../utility/lmdb/UpsertRecordsResponseObject');

const TIMESTAMP = Date.now();
const UUID_VALUE = 'aaa-111-bbb-222';

const BASE_TEST_PATH = path.join(test_utils.getMockLMDBPath(), 'lmdbTest');
let TEST_ENVIRONMENT_NAME = 'test';
const HASH_ATTRIBUTE_NAME = 'id';
const ALL_ATTRIBUTES = ['id', 'name', 'age', '__createdtime__', '__updatedtime__'];
const ONE_RECORD_ARRAY = [{ id: 1, name: 'Kyle', age: 46 }];

const ONE_RECORD_ARRAY_EXPECTED = [
	{ __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP, id: 1, name: 'Kyle', age: 46 },
];

const UPDATE_ONE_RECORD_ARRAY = [{ id: 1, name: 'Kyle Bernhardy', age: 46, height: '6\'1"' }];

const UPDATE_ONE_RECORD_ARRAY_EXPECTED = [
	{ __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP, id: 1, name: 'Kyle Bernhardy', age: 46, height: '6\'1"' },
];

const sandbox = sinon.createSandbox();

const UPDATE_ONE_FAKE_RECORD = { id: 111, name: 'FAKE ROW', age: 0 };
const UPDATE_ONE_FAKE_RECORD_EXPECTED = {
	__createdtime__: TIMESTAMP,
	__updatedtime__: TIMESTAMP,
	id: 111,
	name: 'FAKE ROW',
	age: 0,
};

const TXN_TIMESTAMP = TIMESTAMP;

const generateValidationErr = (msg) => {
	return test_utils.generateHDBError(msg, 400);
};

describe('Test writeUtility module', () => {
	let get_monotonic_time_stub;

	describe('Test validateInsert function', () => {
		let env, transaction;
		before(async () => {
			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
			await fs.mkdirp(BASE_TEST_PATH);
			TEST_ENVIRONMENT_NAME = uuid();
			env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
		});

		after(async () => {
			await env.close();
			sandbox.restore();

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('test function', () => {
			test_utils.assertErrorSync(rw_write_validator, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'pass no args');
			test_utils.assertErrorSync(
				rw_write_validator,
				['test'],
				LMDB_TEST_ERRORS.INVALID_ENVIRONMENT,
				'pass invalid env'
			);
			test_utils.assertErrorSync(
				rw_write_validator,
				[env],
				LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED,
				'pass valid env, no other args'
			);
			test_utils.assertErrorSync(
				rw_write_validator,
				[env, HASH_ATTRIBUTE_NAME],
				LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_REQUIRED,
				'pass valid env hash_attribute'
			);
			test_utils.assertErrorSync(
				rw_write_validator,
				[env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME],
				LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY,
				'pass valid env hash_attribute, invalid all_attributes'
			);
			test_utils.assertErrorSync(
				rw_write_validator,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES],
				LMDB_TEST_ERRORS.RECORDS_REQUIRED,
				'pass valid env hash_attribute all_attributes'
			);
			let record = test_utils.deepClone(ONE_RECORD_ARRAY[0]);
			test_utils.assertErrorSync(
				rw_write_validator,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, record],
				LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY,
				'pass valid env hash_attribute all_attributes, invalid records'
			);
			test_utils.assertErrorSync(
				rw_write_validator,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, []],
				undefined,
				'pass valid env hash_attribute all_attributes records'
			);
		});
	});

	describe('Test setTimestamps function', () => {
		let rw_set_timestamps;
		before(() => {
			rw_set_timestamps = write_utility.__get__('setTimestamps');
			sandbox.restore();
			get_monotonic_time_stub = sandbox.stub(common, 'getNextMonotonicTime').returns(TXN_TIMESTAMP);
		});
		after(() => {
			get_monotonic_time_stub.restore();
		});

		it('pass record, is insert = true, expect timestamps created', () => {
			let record = test_utils.deepClone(ONE_RECORD_ARRAY[0]);

			rw_set_timestamps(record, true, TIMESTAMP);
			assert.deepStrictEqual(record.__updatedtime__, TIMESTAMP);
			assert.deepStrictEqual(record.__createdtime__, TIMESTAMP);
		});
		it('pass record, is insert = true, generate timestamp false, no stamps on record', () => {
			let record = test_utils.deepClone(ONE_RECORD_ARRAY[0]);

			rw_set_timestamps(record, true, false);
			assert.deepStrictEqual(record.__updatedtime__, TIMESTAMP);
			assert.deepStrictEqual(record.__createdtime__, TIMESTAMP);
		});

		it('pass record, is insert = true, generate timestamp false, non-numeric stamps on record', () => {
			let record = test_utils.deepClone(ONE_RECORD_ARRAY[0]);
			record.__createdtime__ = 'heyyy';
			record.__updatedtime__ = 'heyyy';
			rw_set_timestamps(record, true, false);
			assert.deepStrictEqual(record.__updatedtime__, TIMESTAMP);
			assert.deepStrictEqual(record.__createdtime__, TIMESTAMP);
		});

		it('pass record, is insert = false, generate timestamp true', () => {
			let record = test_utils.deepClone(ONE_RECORD_ARRAY[0]);
			record.__createdtime__ = 'heyyy';
			record.__updatedtime__ = 'heyyy';
			rw_set_timestamps(record, false, TIMESTAMP);
			assert.deepStrictEqual(record.__updatedtime__, TIMESTAMP);
			assert.deepStrictEqual(record.__createdtime__, undefined);
		});

		it('pass record, is insert = false, generate timestamp false', () => {
			let record = test_utils.deepClone(ONE_RECORD_ARRAY[0]);
			record.__createdtime__ = 'heyyy';
			record.__updatedtime__ = 'heyyy';
			rw_set_timestamps(record, false, false);
			assert.deepStrictEqual(record.__updatedtime__, TIMESTAMP);
			assert.deepStrictEqual(record.__createdtime__, undefined);
		});

		it('pass record, is insert = false, generate timestamp false timestamps are numbers', () => {
			let record = test_utils.deepClone(ONE_RECORD_ARRAY[0]);
			record.__createdtime__ = 123456;
			record.__updatedtime__ = 123456;
			rw_set_timestamps(record, false, false);
			assert.deepStrictEqual(record.__updatedtime__, 123456);
			assert.deepStrictEqual(record.__createdtime__, undefined);
		});
	});

	describe('Test insertRecords function', () => {
		let stub;
		let get_monotonic_time_stub;
		let env, transaction;
		beforeEach(async () => {
			get_monotonic_time_stub = sandbox.stub(common, 'getNextMonotonicTime').returns(TXN_TIMESTAMP);
			global.lmdb_map = undefined;
			try {
				if (env) await lmdb_env_util.closeEnvironment(env);
			} catch (e) {}
			await fs.remove(test_utils.getMockLMDBPath());
			await fs.mkdirp(BASE_TEST_PATH);
			TEST_ENVIRONMENT_NAME = uuid();
			env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
			await environment_utility.createDBI(env, 'id', false, true);
			await environment_utility.createDBI(env, 'name', true);
			await environment_utility.createDBI(env, 'age', true);
		});

		afterEach(async () => {
			await env.close();
			get_monotonic_time_stub.restore();

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('test validation', () => {
			test_utils.assertErrorAsync(write_utility.insertRecords, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'pass no args');
			test_utils.assertErrorAsync(
				write_utility.insertRecords,
				['test'],
				LMDB_TEST_ERRORS.INVALID_ENVIRONMENT,
				'pass invalid env'
			);
			test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env],
				LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED,
				'pass valid env, no other args'
			);
			test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env, HASH_ATTRIBUTE_NAME],
				LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_REQUIRED,
				'pass valid env hash_attribute'
			);
			test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME],
				LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY,
				'pass valid env hash_attribute, invalid all_attributes'
			);
			test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES],
				LMDB_TEST_ERRORS.RECORDS_REQUIRED,
				'pass valid env hash_attribute all_attributes'
			);
			let record = test_utils.deepClone(ONE_RECORD_ARRAY[0]);
			test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, record],
				LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY,
				'pass valid env hash_attribute all_attributes, invalid records'
			);
			test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, []],
				undefined,
				'pass valid env hash_attribute all_attributes records'
			);
		});

		it('test insert one row', async () => {
			let records = [];
			for (let { key, value } of env.dbis.id.getRange({ start: false })) {
				records.push(value);
			}
			assert.deepStrictEqual(records, []);

			for (let { key, value } of env.dbis.name.getRange({ start: false })) {
				records.push(value);
			}
			assert.deepStrictEqual(records, []);

			for (let { key, value } of env.dbis.age.getRange({ start: false })) {
				records.push(value);
			}
			assert.deepStrictEqual(records, []);

			let insert_records = test_utils.deepClone(ONE_RECORD_ARRAY);
			let result = await test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, insert_records],
				undefined,
				'pass valid env hash_attribute all_attributes records'
			);

			let expected_result = new InsertRecordsResponseObject([1], [], TXN_TIMESTAMP);
			assert.deepStrictEqual(result, expected_result);

			records = [];
			let keys = [];
			for (let { key, value } of env.dbis.id.getRange({ start: false })) {
				keys.push(key);
				records.push(value);
			}
			let expected = [ONE_RECORD_ARRAY_EXPECTED[0]];
			assert.deepStrictEqual(copyRecords(records), expected);
			assert.deepStrictEqual(keys, [1]);

			keys = [];
			records = [];
			for (let { key, value } of env.dbis.name.getRange({ start: false })) {
				keys.push(key);
				records.push(value);
			}
			assert.deepStrictEqual(keys, ['Kyle']);
			assert.deepStrictEqual(records, [1]);

			keys = [];
			records = [];
			for (let { key, value } of env.dbis.age.getRange({ start: false })) {
				keys.push(key);
				records.push(value);
			}
			assert.deepStrictEqual(keys, [46]);
			assert.deepStrictEqual(records, [1]);

			keys = [];
			records = [];
			for (let { key, value } of env.dbis.__createdtime__.getRange({ start: false })) {
				keys.push(key);
				records.push(value);
			}
			assert.deepStrictEqual(records, [1]);
			assert.deepStrictEqual(keys, [TIMESTAMP]);

			keys = [];
			records = [];
			for (let { key, value } of env.dbis.__updatedtime__.getRange({ start: false })) {
				keys.push(key);
				records.push(value);
			}
			assert.deepStrictEqual(records, [1]);
			assert.deepStrictEqual(keys, [TIMESTAMP]);
		});

		it("test insert one row don't generate timestamps", async () => {
			let insert_records = test_utils.deepClone(ONE_RECORD_ARRAY);
			insert_records[0].__updatedtime__ = 123456;
			insert_records[0].__createdtime__ = 123456;
			let result = await test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, insert_records, false],
				undefined,
				'pass valid env hash_attribute all_attributes records'
			);

			let expected_result = new InsertRecordsResponseObject([1], [], TXN_TIMESTAMP);
			assert.deepStrictEqual(result, expected_result);

			assert.deepStrictEqual(insert_records[0].__updatedtime__, 123456);
			assert.deepStrictEqual(insert_records[0].__createdtime__, 123456);

			let records = [];
			let keys = [];
			for (let { key, value } of env.dbis.__updatedtime__.getRange({ start: false })) {
				keys.push(key);
				records.push(value);
			}
			assert.deepStrictEqual(records, [1]);
			assert.deepStrictEqual(keys, [123456]);

			keys = [];
			records = [];
			for (let { key, value } of env.dbis.__createdtime__.getRange({ start: false })) {
				keys.push(key);
				records.push(value);
			}
			assert.deepStrictEqual(records, [1]);
			assert.deepStrictEqual(keys, [123456]);
		});

		it("test insert one row don't generate timestamps, but no timestamps on row", async () => {
			let insert_records = test_utils.deepClone(ONE_RECORD_ARRAY);
			let result = await test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, insert_records, false],
				undefined,
				'pass valid env hash_attribute all_attributes records'
			);

			let expected_result = new InsertRecordsResponseObject([1], [], TXN_TIMESTAMP);
			assert.deepStrictEqual(result, expected_result);

			assert.deepStrictEqual(insert_records[0].__updatedtime__, TIMESTAMP);
			assert.deepStrictEqual(insert_records[0].__createdtime__, TIMESTAMP);

			let records = [];
			let keys = [];
			for (let { key, value } of env.dbis.__updatedtime__.getRange({ start: false })) {
				keys.push(key);
				records.push(value);
			}
			assert.deepStrictEqual(records, [1]);
			assert.deepStrictEqual(keys, [TIMESTAMP]);

			keys = [];
			records = [];
			for (let { key, value } of env.dbis.__createdtime__.getRange({ start: false })) {
				keys.push(key);
				records.push(value);
			}
			assert.deepStrictEqual(records, [1]);
			assert.deepStrictEqual(keys, [TIMESTAMP]);
		});

		it('test insert one row that already exists', async () => {
			let insert_records = test_utils.deepClone(ONE_RECORD_ARRAY);
			let result = await test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, insert_records],
				undefined,
				'pass valid env hash_attribute all_attributes records'
			);

			let expected_result = new InsertRecordsResponseObject([1], [], TXN_TIMESTAMP);
			assert.deepStrictEqual(result, expected_result);

			let records = [];
			let keys = [];
			for (let { key, value } of env.dbis.id.getRange({ start: false })) {
				keys.push(key);
				records.push(value);
			}
			let expected = [ONE_RECORD_ARRAY_EXPECTED[0]];
			assert.deepStrictEqual(copyRecords(records), expected);
			assert.deepStrictEqual(keys, [1]);

			keys = [];
			records = [];
			for (let { key, value } of env.dbis.name.getRange({ start: false })) {
				keys.push(key);
				records.push(value);
			}
			assert.deepStrictEqual(keys, ['Kyle']);
			assert.deepStrictEqual(records, [1]);

			keys = [];
			records = [];
			for (let { key, value } of env.dbis.age.getRange({ start: false })) {
				keys.push(key);
				records.push(value);
			}
			assert.deepStrictEqual(keys, [46]);
			assert.deepStrictEqual(records, [1]);

			result = await test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, insert_records],
				undefined,
				'pass valid env hash_attribute all_attributes records'
			);

			expected_result = new InsertRecordsResponseObject([], [1], TXN_TIMESTAMP);
			assert.deepStrictEqual(result, expected_result);
			assert.deepStrictEqual(insert_records, []);
		});

		it('test long text is written properly', async () => {
			let record = {
				id: 10000,
				text: "Occupy messenger bag microdosing yr, kale chips neutra la croix VHS ugh wayfarers street art. Ethical cronut whatever, cold-pressed viral post-ironic man bun swag marfa green juice. Knausgaard gluten-free selvage ethical subway tile sartorial man bun butcher selfies raclette paleo. Fam brunch plaid woke authentic dreamcatcher hot chicken quinoa gochujang slow-carb selfies keytar PBR&B street art pinterest. Narwhal tote bag glossier paleo cronut salvia cloud bread craft beer butcher meditation fingerstache hella migas 8-bit messenger bag. Tattooed schlitz palo santo gluten-free, wayfarers tumeric squid. Hella keytar thundercats chambray, occupy iPhone paleo slow-carb jianbing everyday carry 90's distillery polaroid fanny pack. Kombucha cray PBR&B shoreditch 8-bit, adaptogen vinyl swag meditation 3 wolf moon. Selvage art party retro kitsch pour-over iPhone street art celiac etsy cred cliche gastropub. Kombucha migas marfa listicle cliche. Godard kombucha ennui lumbersexual, austin pop-up raclette retro. Man braid kale chips pitchfork, tote bag hoodie poke mumblecore. Bitters shoreditch tbh everyday carry keffiyeh raw denim kale chips.",
			};

			let result = await test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env, HASH_ATTRIBUTE_NAME, ['id', 'text'], [record]],
				undefined
			);
			let expected_result = new InsertRecordsResponseObject([record.id], [], TXN_TIMESTAMP);
			assert.deepStrictEqual(result, expected_result);

			let keys = [];
			let records = [];
			for (let { key, value } of env.dbis.text.getRange({ start: false })) {
				keys.push(key);
				records.push(value);
			}
			assert.strictEqual(keys.length, 1);
			assert.deepStrictEqual(records, [10000]);
		});

		it('test insert with alasql function', async () => {
			let now_func = alasql.compile(`SELECT NOW() AS [${hdb_terms.FUNC_VAL}] FROM ?`);
			let rando_func = alasql.compile(`SELECT RANDOM() AS [${hdb_terms.FUNC_VAL}] FROM ?`);

			let record = {
				id: 2000,
				timestamp: now_func,
				rando: rando_func,
			};

			let result = await test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env, HASH_ATTRIBUTE_NAME, ['id', 'timestamp', 'rando'], [record]],
				undefined
			);
			let expected_result = new InsertRecordsResponseObject([record.id], [], TXN_TIMESTAMP);
			assert.deepStrictEqual(result, expected_result);

			let keys = [];
			let values = [];
			for (let { key, value } of env.dbis.timestamp.getRange({ start: false })) {
				keys.push(key);
				values.push(value);
			}
			assert.deepStrictEqual(keys, [record.timestamp]);
			assert.deepStrictEqual(values, [record.id]);

			keys = [];
			values = [];
			for (let { key, value } of env.dbis.rando.getRange({ start: false })) {
				keys.push(key);
				values.push(value);
			}
			assert.deepStrictEqual(keys, [record.rando]);
			assert.deepStrictEqual(values, [record.id]);

			keys = [];
			values = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				keys.push(key);
				values.push(value);
			}
			assert.deepStrictEqual(keys, [2000]);
			assert.deepStrictEqual(copyRecords(values), [record]);
		});
	});

	describe('Test updateRecords function', () => {
		let env, transaction;
		let get_monotonic_time_stub;

		beforeEach(async () => {
			get_monotonic_time_stub = sandbox.stub(common, 'getNextMonotonicTime').returns(TXN_TIMESTAMP);
			global.lmdb_map = undefined;
			try {
				if (env) await lmdb_env_util.closeEnvironment(env);
			} catch (e) {}
			await fs.remove(test_utils.getMockLMDBPath());
			await fs.mkdirp(BASE_TEST_PATH);
			TEST_ENVIRONMENT_NAME = uuid();
			env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
			await environment_utility.createDBI(env, 'id', false, true);
			let insert_records = test_utils.deepClone(ONE_RECORD_ARRAY);
			await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(ALL_ATTRIBUTES), insert_records);
		});

		afterEach(async () => {
			await env.close();
			get_monotonic_time_stub.restore();

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('test validation', async () => {
			await test_utils.assertErrorAsync(write_utility.updateRecords, [], LMDB_TEST_ERRORS.ENV_REQUIRED, 'pass no args');
			await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				['test'],
				LMDB_TEST_ERRORS.INVALID_ENVIRONMENT,
				'pass invalid env'
			);
			await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env],
				LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED,
				'pass valid env, no other args'
			);
			await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME],
				LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_REQUIRED,
				'pass valid env hash_attribute'
			);
			await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME],
				LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY,
				'pass valid env hash_attribute, invalid all_attributes'
			);
			await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES],
				LMDB_TEST_ERRORS.RECORDS_REQUIRED,
				'pass valid env hash_attribute all_attributes'
			);
			let insert_record = test_utils.deepClone(ONE_RECORD_ARRAY[0]);
			await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, insert_record],
				LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY,
				'pass valid env hash_attribute all_attributes, invalid records'
			);
			await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, []],
				undefined,
				'pass valid env hash_attribute all_attributes records'
			);
		});

		it('test update one existing row', async () => {
			let all_attributes_for_update = ['__createdtime__', '__updatedtime__', 'age', 'height', 'id', 'name'];

			let records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}

			let expected = [ONE_RECORD_ARRAY_EXPECTED[0]];
			records = copyRecords(records);
			assert.deepStrictEqual(records, expected);

			let expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, records);

			let update_records = test_utils.deepClone(UPDATE_ONE_RECORD_ARRAY);
			update_records[0]['__createdtime__'] = 'bad value';
			let results = await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, update_records],
				undefined
			);
			assert.deepStrictEqual(results, expected_update_response);

			let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
			assert.deepStrictEqual(all_dbis, all_attributes_for_update);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}
			let expected2 = [UPDATE_ONE_RECORD_ARRAY_EXPECTED[0]];
			assert.deepStrictEqual(copyRecords(records), expected2);
		});

		it('test update one existing row with row whose timestamp is older than row in database', async () => {
			let all_attributes_for_update = ['__createdtime__', '__updatedtime__', 'age', 'height', 'id', 'name'];

			let records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}

			let expected = [ONE_RECORD_ARRAY_EXPECTED[0]];
			records = copyRecords(records);
			assert.deepStrictEqual(records, expected);

			let expected_update_response = new UpdateRecordsResponseObject([], [1], TXN_TIMESTAMP, []);

			let update_records = test_utils.deepClone(UPDATE_ONE_RECORD_ARRAY);
			update_records[0]['__updatedtime__'] = TIMESTAMP - 100;
			let results = await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, update_records, false],
				undefined
			);
			assert.deepStrictEqual(results, expected_update_response);

			let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
			assert.deepStrictEqual(all_dbis, all_attributes_for_update);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}
			assert.deepStrictEqual(copyRecords(records), expected);
		});

		it('test update one existing row, generate timestamps = false, but no updatedtimestamp', async () => {
			let all_attributes_for_update = ['__createdtime__', '__updatedtime__', 'age', 'height', 'id', 'name'];

			let records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}

			let expected = [ONE_RECORD_ARRAY_EXPECTED[0]];
			assert.deepStrictEqual(copyRecords(records), expected);

			let expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, copyRecords(records));

			let update_records = test_utils.deepClone(UPDATE_ONE_RECORD_ARRAY);
			update_records[0]['__createdtime__'] = 'bad value';
			let results = await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, update_records, false],
				undefined
			);
			assert.deepStrictEqual(results, expected_update_response);

			let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
			assert.deepStrictEqual(all_dbis, all_attributes_for_update);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}
			let expected2 = [UPDATE_ONE_RECORD_ARRAY_EXPECTED[0]];
			assert.deepStrictEqual(copyRecords(records), expected2);
		});

		it('test update one existing row, generate timestamps = false, updated timestamp is newer the one in db', async () => {
			let all_attributes_for_update = ['__createdtime__', '__updatedtime__', 'age', 'height', 'id', 'name'];

			let records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}
			records = copyRecords(records);
			let expected = [ONE_RECORD_ARRAY_EXPECTED[0]];
			assert.deepStrictEqual(records, expected);

			let expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, records);

			let update_records = test_utils.deepClone(UPDATE_ONE_RECORD_ARRAY);
			let updated_time = TIMESTAMP + 1;
			update_records[0]['__createdtime__'] = 'bad value';
			update_records[0]['__updatedtime__'] = updated_time;
			let results = await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, update_records, false],
				undefined
			);
			assert.deepStrictEqual(results, expected_update_response);

			let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
			assert.deepStrictEqual(all_dbis, all_attributes_for_update);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}
			let expected2 = test_utils.deepClone([UPDATE_ONE_RECORD_ARRAY_EXPECTED[0]]);
			expected2[0].__updatedtime__ = updated_time;
			assert.deepStrictEqual(copyRecords(records), expected2);
		});

		it('test update one existing row & one non-existing row', async () => {
			let all_attributes_for_update = ['__createdtime__', '__updatedtime__', 'age', 'height', 'id', 'name'];

			let records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}
			let orig_records = copyRecords(records);
			assert.deepStrictEqual(orig_records, ONE_RECORD_ARRAY_EXPECTED);

			let update_records = test_utils.deepClone(UPDATE_ONE_RECORD_ARRAY.concat(UPDATE_ONE_FAKE_RECORD));
			let results = await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, update_records],
				undefined
			);

			let expected_update_response = new UpdateRecordsResponseObject([1], [111], TXN_TIMESTAMP, orig_records);

			let expected_update_records = test_utils.deepClone(UPDATE_ONE_RECORD_ARRAY);
			expected_update_records[0].__updatedtime__ = TIMESTAMP;
			assert.deepStrictEqual(update_records, expected_update_records);
			assert.deepStrictEqual(results, expected_update_response);

			let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
			assert.deepStrictEqual(all_dbis, all_attributes_for_update);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}
			assert.deepStrictEqual(copyRecords(records), UPDATE_ONE_RECORD_ARRAY_EXPECTED);
		});

		it('test partially updating row & make sure other attributes are untouched', async () => {
			let all_attributes_for_update = ['__createdtime__', '__updatedtime__', 'age', 'city', 'height', 'id', 'name'];

			let records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}
			assert.deepStrictEqual(copyRecords(records), ONE_RECORD_ARRAY_EXPECTED);

			let orig_records = copyRecords(records);
			let expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, orig_records);

			let results = await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, [{ id: 1, city: 'Denver' }]],
				undefined
			);
			assert.deepStrictEqual(results, expected_update_response);

			let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
			assert.deepStrictEqual(all_dbis, all_attributes_for_update);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}

			let expected2 = [
				{ id: 1, name: 'Kyle', city: 'Denver', age: 46, __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP },
			];
			assert.deepStrictEqual(copyRecords(records), expected2);
		});

		it('test partially updating row to have long text, then change the long text', async () => {
			let all_attributes_for_update = [
				'__createdtime__',
				'__updatedtime__',
				'age',
				'height',
				'id',
				'name',
				'city',
				'text',
			];
			let record = {
				id: 1,
				text: "Occupy messenger bag microdosing yr, kale chips neutra la croix VHS ugh wayfarers street art. Ethical cronut whatever, cold-pressed viral post-ironic man bun swag marfa green juice. Knausgaard gluten-free selvage ethical subway tile sartorial man bun butcher selfies raclette paleo. Fam brunch plaid woke authentic dreamcatcher hot chicken quinoa gochujang slow-carb selfies keytar PBR&B street art pinterest. Narwhal tote bag glossier paleo cronut salvia cloud bread craft beer butcher meditation fingerstache hella migas 8-bit messenger bag. Tattooed schlitz palo santo gluten-free, wayfarers tumeric squid. Hella keytar thundercats chambray, occupy iPhone paleo slow-carb jianbing everyday carry 90's distillery polaroid fanny pack. Kombucha cray PBR&B shoreditch 8-bit, adaptogen vinyl swag meditation 3 wolf moon. Selvage art party retro kitsch pour-over iPhone street art celiac etsy cred cliche gastropub. Kombucha migas marfa listicle cliche. Godard kombucha ennui lumbersexual, austin pop-up raclette retro. Man braid kale chips pitchfork, tote bag hoodie poke mumblecore. Bitters shoreditch tbh everyday carry keffiyeh raw denim kale chips.",
			};

			let records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}
			assert.deepStrictEqual(copyRecords(records), ONE_RECORD_ARRAY_EXPECTED);

			let orig_records = copyRecords(records);
			let expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, orig_records);

			let results = await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, [record]],
				undefined
			);
			assert.deepStrictEqual(results, expected_update_response);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}
			let expected2 = [
				{ id: 1, name: 'Kyle', age: 46, text: record.text, __updatedtime__: TIMESTAMP, __createdtime__: TIMESTAMP },
			];
			assert.deepStrictEqual(copyRecords(records), expected2);

			//set text to undefined & verify it's gone

			orig_records = copyRecords(records);
			expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, orig_records);

			results = await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, [{ id: 1, text: null }]],
				undefined
			);
			assert.deepStrictEqual(results, expected_update_response);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}

			expected2 = [
				{ id: 1, name: 'Kyle', age: 46, text: null, __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP },
			];
			let copy_records = copyRecords(records);
			assert.deepStrictEqual(copy_records, expected2);
		});

		it('test partially updating row to have long text which is json, then remove the json', async () => {
			let all_attributes_for_update = [
				'__createdtime__',
				'__updatedtime__',
				'age',
				'height',
				'id',
				'name',
				'city',
				'json',
			];
			let record = {
				id: 1,
				json: {
					text: "Occupy messenger bag microdosing yr, kale chips neutra la croix VHS ugh wayfarers street art. Ethical cronut whatever, cold-pressed viral post-ironic man bun swag marfa green juice. Knausgaard gluten-free selvage ethical subway tile sartorial man bun butcher selfies raclette paleo. Fam brunch plaid woke authentic dreamcatcher hot chicken quinoa gochujang slow-carb selfies keytar PBR&B street art pinterest. Narwhal tote bag glossier paleo cronut salvia cloud bread craft beer butcher meditation fingerstache hella migas 8-bit messenger bag. Tattooed schlitz palo santo gluten-free, wayfarers tumeric squid. Hella keytar thundercats chambray, occupy iPhone paleo slow-carb jianbing everyday carry 90's distillery polaroid fanny pack. Kombucha cray PBR&B shoreditch 8-bit, adaptogen vinyl swag meditation 3 wolf moon. Selvage art party retro kitsch pour-over iPhone street art celiac etsy cred cliche gastropub. Kombucha migas marfa listicle cliche. Godard kombucha ennui lumbersexual, austin pop-up raclette retro. Man braid kale chips pitchfork, tote bag hoodie poke mumblecore. Bitters shoreditch tbh everyday carry keffiyeh raw denim kale chips.",
				},
			};

			let records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}

			assert.deepEqual(copyRecords(records), ONE_RECORD_ARRAY_EXPECTED);

			let orig_records = copyRecords(records);
			let expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, orig_records);

			let results = await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, [record]],
				undefined
			);
			assert.deepStrictEqual(results, expected_update_response);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}
			let expected2 = [
				{ id: 1, name: 'Kyle', age: 46, json: record.json, __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP },
			];
			orig_records = copyRecords(records);
			assert.deepStrictEqual(orig_records, expected2);

			//set json to undefined & verify it's gone

			expected_update_response = new UpdateRecordsResponseObject([1], [], TXN_TIMESTAMP, orig_records);

			results = await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, [{ id: 1, json: null }]],
				undefined
			);
			assert.deepStrictEqual(results, expected_update_response);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(value);
			}
			expected2 = [
				{ id: 1, name: 'Kyle', age: 46, json: null, __updatedtime__: TIMESTAMP, __createdtime__: TIMESTAMP },
			];
			assert.deepStrictEqual(copyRecords(records), expected2);
		});

		it('test update with alasql function', async () => {
			let now_func = alasql.compile(`SELECT NOW() AS [${hdb_terms.FUNC_VAL}] FROM ?`);
			let rando_func = alasql.compile(`SELECT RANDOM() AS [${hdb_terms.FUNC_VAL}] FROM ?`);

			let record = {
				id: 2000,
				timestamp: now_func,
				rando: rando_func,
			};

			let result = await test_utils.assertErrorAsync(
				write_utility.insertRecords,
				[env, HASH_ATTRIBUTE_NAME, ['id', 'timestamp', 'rando'], [record]],
				undefined
			);

			assert.deepStrictEqual(result, new InsertRecordsResponseObject([record.id], [], TXN_TIMESTAMP));

			let results = iterateIndex(env, 'timestamp');
			let time_stamp_dbi = { [record.timestamp]: [record.id] };
			assert.deepStrictEqual(results, { ...time_stamp_dbi });

			results = iterateIndex(env, 'rando');
			let rando_dbi = { [record.rando]: [record.id] };
			assert.deepStrictEqual(results, { ...rando_dbi });

			let records = env.dbis[HASH_ATTRIBUTE_NAME].get(record.id);
			assert.deepStrictEqual(records, record);

			let orig_records = [{ ...records }];
			let expected_update_response = new UpdateRecordsResponseObject([record.id], [], TXN_TIMESTAMP, orig_records);

			rando_func = alasql.compile(`SELECT rando + 1 AS [${hdb_terms.FUNC_VAL}] FROM ?`);

			record = { ...record }; // copy, so we don't modify the record in the cache
			record.rando = rando_func;
			result = await test_utils.assertErrorAsync(
				write_utility.updateRecords,
				[env, HASH_ATTRIBUTE_NAME, ['id', 'timestamp', 'rando'], [record]],
				undefined
			);
			assert.deepStrictEqual(result, expected_update_response);

			results = iterateIndex(env, 'rando');
			rando_dbi = { [record.rando]: [record.id] };
			assert.deepStrictEqual(results, { ...rando_dbi });

			record.__createdtime__ = TIMESTAMP;
			records = env.dbis[HASH_ATTRIBUTE_NAME].get(record.id);
			assert.deepStrictEqual(records, record);
		});
	});

	describe('Test upsertRecords function', () => {
		let env, transaction;
		let get_monotonic_time_stub;
		let uuid_stub;
		before(() => {
			uuid_stub = write_utility.__set__('uuid', {
				v4: () => {
					return UUID_VALUE;
				},
			});
		});

		after(() => {
			uuid_stub();
		});

		beforeEach(async () => {
			get_monotonic_time_stub = sandbox.stub(common, 'getNextMonotonicTime').returns(TXN_TIMESTAMP);
			global.lmdb_map = undefined;
			try {
				if (env) await lmdb_env_util.closeEnvironment(env);
			} catch (e) {}
			await fs.remove(test_utils.getMockLMDBPath());
			await fs.mkdirp(BASE_TEST_PATH);
			TEST_ENVIRONMENT_NAME = uuid();
			env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
			await environment_utility.createDBI(env, 'id', false, true);
			let insert_records = test_utils.deepClone(ONE_RECORD_ARRAY);
			await write_utility.insertRecords(env, HASH_ATTRIBUTE_NAME, test_utils.deepClone(ALL_ATTRIBUTES), insert_records);
		});

		afterEach(async () => {
			await env.close();
			get_monotonic_time_stub.restore();

			global.lmdb_map = undefined;
			await fs.remove(test_utils.getMockLMDBPath());
		});

		it('test validation', async () => {
			await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[],
				generateValidationErr(LMDB_TEST_ERRORS.ENV_REQUIRED.message),
				'pass no args'
			);
			await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				['test'],
				generateValidationErr(LMDB_TEST_ERRORS.INVALID_ENVIRONMENT.message),
				'pass invalid env'
			);
			await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env],
				generateValidationErr(LMDB_TEST_ERRORS.HASH_ATTRIBUTE_REQUIRED.message),
				'pass valid env, no other args'
			);
			await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME],
				generateValidationErr(LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_REQUIRED.message),
				'pass valid env hash_attribute'
			);
			await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, HASH_ATTRIBUTE_NAME],
				generateValidationErr(LMDB_TEST_ERRORS.WRITE_ATTRIBUTES_MUST_BE_ARRAY.message),
				'pass valid env hash_attribute, invalid all_attributes'
			);
			await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES],
				generateValidationErr(LMDB_TEST_ERRORS.RECORDS_REQUIRED.message),
				'pass valid env hash_attribute all_attributes'
			);
			let record = test_utils.deepClone(ONE_RECORD_ARRAY[0]);
			await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, record],
				generateValidationErr(LMDB_TEST_ERRORS.RECORDS_MUST_BE_ARRAY.message),
				'pass valid env hash_attribute all_attributes, invalid records'
			);
			await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, []],
				undefined,
				'pass valid env hash_attribute all_attributes records'
			);
		});

		it("test upsert one row doesn't exist", async () => {
			//test no records
			let record = env.dbis[HASH_ATTRIBUTE_NAME].get(999);
			assert.deepStrictEqual(record, undefined);
			let insert_records = [{ id: 999, name: 'Cool Dude', age: '?' }];
			let result = await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, insert_records],
				undefined,
				'pass valid env hash_attribute all_attributes records'
			);

			let expected_result = new UpsertRecordsResponseObject([999], TXN_TIMESTAMP);
			assert.deepStrictEqual(result, expected_result);

			record = env.dbis[HASH_ATTRIBUTE_NAME].get(999);
			assert.deepStrictEqual(record, insert_records[0]);
		});

		it("test upsert one row doesn't exist with no hash attribute value", async () => {
			//test no records
			let record = env.dbis[HASH_ATTRIBUTE_NAME].get(UUID_VALUE);
			assert.deepStrictEqual(record, undefined);
			let insert_records = [{ name: 'Cool Dude', age: '?' }];
			let result = await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, ALL_ATTRIBUTES, insert_records],
				undefined,
				'pass valid env hash_attribute all_attributes records'
			);

			let expected_result = new UpsertRecordsResponseObject([UUID_VALUE], TXN_TIMESTAMP);
			assert.deepStrictEqual(result, expected_result);

			record = env.dbis[HASH_ATTRIBUTE_NAME].get(UUID_VALUE);
			assert.deepStrictEqual(record, insert_records[0]);
		});

		it('test upsert one existing row', async () => {
			let all_attributes_for_update = ['__createdtime__', '__updatedtime__', 'age', 'height', 'id', 'name'];

			let records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(copyRecord(value));
			}
			let expected = [ONE_RECORD_ARRAY_EXPECTED[0]];
			assert.deepStrictEqual(records, expected);

			let orig_records = [];
			records.forEach((rec) => {
				let record = { ...rec };
				orig_records.push(record);
			});
			let expected_upsert_response = new UpsertRecordsResponseObject([1], TXN_TIMESTAMP, orig_records);

			let upsert_records = test_utils.deepClone(UPDATE_ONE_RECORD_ARRAY);
			upsert_records[0]['__createdtime__'] = 'bad value';
			let results = await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, upsert_records],
				undefined
			);
			assert.deepStrictEqual(results, expected_upsert_response);

			let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
			assert.deepStrictEqual(all_dbis, all_attributes_for_update);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(copyRecord(value));
			}
			assert.deepStrictEqual(records, [UPDATE_ONE_RECORD_ARRAY_EXPECTED[0]]);
		});

		it('test upsert one existing row & one non-existing row', async () => {
			let all_attributes_for_update = ['__createdtime__', '__updatedtime__', 'age', 'height', 'id', 'name'];

			let records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(copyRecord(value));
			}
			let expected = [ONE_RECORD_ARRAY_EXPECTED[0]];
			assert.deepStrictEqual(records, expected);
			let upsert_records = test_utils.deepClone(UPDATE_ONE_RECORD_ARRAY.concat(UPDATE_ONE_FAKE_RECORD));
			let results = await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_update, upsert_records],
				undefined
			);

			let orig_records = [];
			records.forEach((rec) => {
				let record = { ...rec };
				orig_records.push(record);
			});
			let expected_upsert_response = new UpsertRecordsResponseObject([1, 111], TXN_TIMESTAMP, orig_records);

			let expected_upsert_records = test_utils.deepClone(UPDATE_ONE_RECORD_ARRAY.concat(UPDATE_ONE_FAKE_RECORD));
			expected_upsert_records[0].__updatedtime__ = TIMESTAMP;
			expected_upsert_records[1].__updatedtime__ = TIMESTAMP;
			expected_upsert_records[1].__createdtime__ = TIMESTAMP;
			assert.deepStrictEqual(upsert_records, expected_upsert_records);
			assert.deepStrictEqual(results, expected_upsert_response);

			let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [env], undefined);
			assert.deepStrictEqual(all_dbis, all_attributes_for_update);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(copyRecord(value));
			}
			let expected2 = [UPDATE_ONE_RECORD_ARRAY_EXPECTED[0], UPDATE_ONE_FAKE_RECORD_EXPECTED];
			assert.deepStrictEqual(records, expected2);
		});

		it('test partially upserting row & make sure other attributes are untouched', async () => {
			let all_attributes_for_upsert = ['__createdtime__', '__updatedtime__', 'age', 'height', 'id', 'name', 'city'];

			let records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(copyRecord(value));
			}
			assert.deepStrictEqual(records, ONE_RECORD_ARRAY_EXPECTED);

			let orig_records = [];
			records.forEach((rec) => {
				let record = { ...rec };
				orig_records.push(record);
			});
			let expected_upsert_response = new UpsertRecordsResponseObject([1], TXN_TIMESTAMP, orig_records);

			let results = await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_upsert, [{ id: 1, city: 'Denver' }]],
				undefined
			);
			assert.deepStrictEqual(results, expected_upsert_response);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(copyRecord(value));
			}
			let expected2 = [
				{ id: 1, name: 'Kyle', city: 'Denver', age: 46, __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP },
			];
			assert.deepStrictEqual(records, expected2);
		});

		it('test partially upserting row to have long text, then change the long text', async () => {
			let all_attributes_for_upsert = [
				'__createdtime__',
				'__updatedtime__',
				'age',
				'height',
				'id',
				'name',
				'city',
				'text',
			];
			let record = {
				id: 1,
				text: "Occupy messenger bag microdosing yr, kale chips neutra la croix VHS ugh wayfarers street art. Ethical cronut whatever, cold-pressed viral post-ironic man bun swag marfa green juice. Knausgaard gluten-free selvage ethical subway tile sartorial man bun butcher selfies raclette paleo. Fam brunch plaid woke authentic dreamcatcher hot chicken quinoa gochujang slow-carb selfies keytar PBR&B street art pinterest. Narwhal tote bag glossier paleo cronut salvia cloud bread craft beer butcher meditation fingerstache hella migas 8-bit messenger bag. Tattooed schlitz palo santo gluten-free, wayfarers tumeric squid. Hella keytar thundercats chambray, occupy iPhone paleo slow-carb jianbing everyday carry 90's distillery polaroid fanny pack. Kombucha cray PBR&B shoreditch 8-bit, adaptogen vinyl swag meditation 3 wolf moon. Selvage art party retro kitsch pour-over iPhone street art celiac etsy cred cliche gastropub. Kombucha migas marfa listicle cliche. Godard kombucha ennui lumbersexual, austin pop-up raclette retro. Man braid kale chips pitchfork, tote bag hoodie poke mumblecore. Bitters shoreditch tbh everyday carry keffiyeh raw denim kale chips.",
			};

			let records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(copyRecord(value));
			}
			assert.deepStrictEqual(records, ONE_RECORD_ARRAY_EXPECTED);

			let orig_records = [];
			records.forEach((rec) => {
				let record = { ...rec };
				orig_records.push(record);
			});
			let expected_upsert_response = new UpsertRecordsResponseObject([1], TXN_TIMESTAMP, orig_records);

			let results = await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_upsert, [record]],
				undefined
			);
			assert.deepStrictEqual(results, expected_upsert_response);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(copyRecord(value));
			}
			let expected2 = [
				{ id: 1, name: 'Kyle', age: 46, text: record.text, __updatedtime__: TIMESTAMP, __createdtime__: TIMESTAMP },
			];
			assert.deepStrictEqual(records, expected2);

			//set text to undefined & verify it's gone

			orig_records = [];
			records.forEach((rec) => {
				orig_records.push(copyRecord(rec));
			});
			expected_upsert_response = new UpsertRecordsResponseObject([1], TXN_TIMESTAMP, orig_records);

			results = await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_upsert, [{ id: 1, text: null }]],
				undefined
			);
			assert.deepStrictEqual(results, expected_upsert_response);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(copyRecord(value));
			}
			expected2 = [
				{ id: 1, name: 'Kyle', age: 46, text: null, __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP },
			];
			assert.deepStrictEqual(records, expected2);
		});

		it('test partially upserting row to have long text which is json, then remove the json', async () => {
			let all_attributes_for_upsert = [
				'__createdtime__',
				'__updatedtime__',
				'age',
				'height',
				'id',
				'name',
				'city',
				'json',
			];
			let record = {
				id: 1,
				json: {
					text: "Occupy messenger bag microdosing yr, kale chips neutra la croix VHS ugh wayfarers street art. Ethical cronut whatever, cold-pressed viral post-ironic man bun swag marfa green juice. Knausgaard gluten-free selvage ethical subway tile sartorial man bun butcher selfies raclette paleo. Fam brunch plaid woke authentic dreamcatcher hot chicken quinoa gochujang slow-carb selfies keytar PBR&B street art pinterest. Narwhal tote bag glossier paleo cronut salvia cloud bread craft beer butcher meditation fingerstache hella migas 8-bit messenger bag. Tattooed schlitz palo santo gluten-free, wayfarers tumeric squid. Hella keytar thundercats chambray, occupy iPhone paleo slow-carb jianbing everyday carry 90's distillery polaroid fanny pack. Kombucha cray PBR&B shoreditch 8-bit, adaptogen vinyl swag meditation 3 wolf moon. Selvage art party retro kitsch pour-over iPhone street art celiac etsy cred cliche gastropub. Kombucha migas marfa listicle cliche. Godard kombucha ennui lumbersexual, austin pop-up raclette retro. Man braid kale chips pitchfork, tote bag hoodie poke mumblecore. Bitters shoreditch tbh everyday carry keffiyeh raw denim kale chips.",
				},
			};

			let records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(copyRecord(value));
			}
			assert.deepEqual(records, ONE_RECORD_ARRAY_EXPECTED);

			let orig_records = [];
			records.forEach((rec) => {
				orig_records.push(copyRecord(rec));
			});
			let expected_upsert_response = new UpsertRecordsResponseObject([1], TXN_TIMESTAMP, orig_records);

			let results = await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_upsert, [record]],
				undefined
			);
			assert.deepStrictEqual(results, expected_upsert_response);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(copyRecord(value));
			}
			let expected2 = [
				{ id: 1, name: 'Kyle', age: 46, json: record.json, __createdtime__: TIMESTAMP, __updatedtime__: TIMESTAMP },
			];
			assert.deepStrictEqual(records, expected2);

			//set json to undefined & verify it's gone

			orig_records = [];
			orig_records.push({ ...records[0] });
			expected_upsert_response = new UpsertRecordsResponseObject([1], TXN_TIMESTAMP, orig_records);

			results = await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, all_attributes_for_upsert, [{ id: 1, json: null }]],
				undefined
			);
			assert.deepStrictEqual(results, expected_upsert_response);

			records = [];
			for (let { key, value } of env.dbis[HASH_ATTRIBUTE_NAME].getRange({ start: false })) {
				records.push(copyRecord(value));
			}
			expected2 = [
				{ id: 1, name: 'Kyle', age: 46, json: null, __updatedtime__: TIMESTAMP, __createdtime__: TIMESTAMP },
			];
			assert.deepStrictEqual(records, expected2);
		});

		it('test upsert with alasql function', async () => {
			let now_func = alasql.compile(`SELECT NOW() AS [${hdb_terms.FUNC_VAL}] FROM ?`);
			let rando_func = alasql.compile(`SELECT RANDOM() AS [${hdb_terms.FUNC_VAL}] FROM ?`);

			let record = {
				id: 2000,
				timestamp: now_func,
				rando: rando_func,
			};

			let result = await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, ['id', 'timestamp', 'rando'], [record]],
				undefined
			);

			assert.deepStrictEqual(result, new UpsertRecordsResponseObject([record.id], TXN_TIMESTAMP));

			let results = iterateIndex(env, 'timestamp');
			let time_stamp_dbi = { [record.timestamp]: [record.id] };
			assert.deepStrictEqual(results, { ...time_stamp_dbi });

			results = iterateIndex(env, 'rando');
			let rando_dbi = { [record.rando]: [record.id] };
			assert.deepStrictEqual(results, { ...rando_dbi });

			let records = env.dbis[HASH_ATTRIBUTE_NAME].get(record.id);
			assert.deepStrictEqual(records, record);

			let orig_records = [{ ...records }];
			let expected_upsert_response = new UpsertRecordsResponseObject([record.id], TXN_TIMESTAMP, orig_records);

			rando_func = alasql.compile(`SELECT rando + 1 AS [${hdb_terms.FUNC_VAL}] FROM ?`);

			record.rando = rando_func;
			result = await test_utils.assertErrorAsync(
				write_utility.upsertRecords,
				[env, HASH_ATTRIBUTE_NAME, ['id', 'timestamp', 'rando'], [record]],
				undefined
			);
			assert.deepStrictEqual(result, expected_upsert_response);

			results = iterateIndex(env, 'rando');
			rando_dbi = { [record.rando]: [record.id] };
			assert.deepStrictEqual(results, { ...rando_dbi });
			record.__createdtime__ = TIMESTAMP;
			records = env.dbis[HASH_ATTRIBUTE_NAME].get(record.id);
			assert.deepStrictEqual(records, record);
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

function copyRecord(record) {
	let copied = {};
	for (let key in record) {
		copied[key] = record[key];
	}
	return copied;
}
function copyRecords(records) {
	return records.map(copyRecord);
}
