'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');

const rewire = require('rewire');
const assert = require('assert');
// need to rewire in order to override p_search_search_by_value
const schema_describe = rewire('../../dataLayer/schemaDescribe');
const start_time = Date.now();

const TEST_DATA_DOG = [
	{
		age: 5,
		breed: 'Mutt',
		id: 1,
		name: 'Sam',
	},
	{
		age: 4,
		breed: 'Golden Retriever',
		id: 2,
		name: 'David',
	},
	{
		age: 10,
		breed: 'Pit Bull',
		id: 3,
		name: 'Kyle',
	},
	{
		age: 10,
		breed: 'Pit',
		id: 4,
		name: 'Sam',
	},
	{
		age: 15,
		breed: 'Poodle',
		id: 5,
		name: 'Eli',
	},
	{
		age: 8,
		breed: 'Poodle',
		id: 6,
		name: 'Sarah',
	},
];

let SEARCH_STUB_RESULTS = [
	{
		id: '6e175c63-575c-4f0c-beb0-0586a4fbcaf3',
		name: 'dog',
		hash_attribute: 'id',
		schema: 'dev',
		residence: null,
	},
];

const test_data = test_util.deepClone(TEST_DATA_DOG);
const TEST_SCHEMA = 'dev';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_DOG = 'dog';

const DESCRIBE_SCHEMA_MESSAGE = {
	operation: 'describe_schema',
	schema: `${TEST_SCHEMA}`,
};

const DESCRIBE_TABLE_MESSAGE = {
	operation: 'describe_schema',
	schema: `${TEST_SCHEMA}`,
	table: `${TEST_TABLE_DOG}`,
};

let test_envs;

describe('Test describeAll', function () {
	let search_orig = undefined;
	let desc_table_orig = undefined;
	let sandbox = undefined;

	before(async function () {
		test_envs = await test_util.createMockDB(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data);
		desc_table_orig = schema_describe.describeTable;
		sandbox = sinon.createSandbox();
	});

	after(async function () {
		await test_util.tearDownMockDB(test_envs);
		test_envs = [];
		desc_table_orig = schema_describe.describeTable;
	});

	it('describeAll, test nominal case', async function () {
		let all_schema = await schema_describe.describeAll();
		assert.strictEqual(Object.keys(all_schema).length, 1, 'expected schema not found');
	});

	it('describeAll, test search exception', async function () {
		let search_stub_throw = sandbox.stub().throws(new Error('search error'));
		const get_db_rw = schema_describe.__set__('getDatabases', search_stub_throw);
		let all_schema = await schema_describe.describeAll();
		assert.strictEqual(all_schema instanceof Error, true, 'expected exception');
		// restore the original search
		get_db_rw();
	});

	it('describeAll, test descTable exception', async function () {
		let desc_table_stub_throw = sandbox.stub().throws(new Error('descTable error'));
		schema_describe.__set__('descTable', desc_table_stub_throw);
		let all_schema = await schema_describe.describeAll();
		assert.strictEqual(Object.keys(all_schema).length, 1, 'expected dev');
		assert.deepStrictEqual(all_schema[TEST_SCHEMA], {}, 'expected empty schema');
		// restore the original search
		schema_describe.__set__('descTable', desc_table_orig);
	});
});

describe('Test describeSchema', function () {
	let search_orig = undefined;
	let desc_table_orig = undefined;
	let sandbox = undefined;
	before(async function () {
		test_envs = await test_util.createMockDB(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data);
		desc_table_orig = schema_describe.describeTable;
		sandbox = sinon.createSandbox();
	});

	after(async function () {
		await test_util.tearDownMockDB(test_envs);
		test_envs = [];
		sandbox.restore();
	});

	it('describeSchema, test nominal case', async function () {
		let desc_schema = await schema_describe.describeSchema(DESCRIBE_SCHEMA_MESSAGE);
		assert.strictEqual(Object.keys(desc_schema).length, 1, 'expected schema not found');
	});

	it('describeSchema, test no schema error', async function () {
		let error;
		try {
			let desc_schema = await schema_describe.describeSchema({});
		} catch (err) {
			error = err;
		}
		assert.strictEqual(error.message, "database 'data' does not exist");
	});

	it('describeSchema, test search exception', async function () {
		let search_stub_throw = sandbox.stub().throws(new Error('search error'));
		const get_db_rw = schema_describe.__set__('getDatabases', search_stub_throw);
		let desc_schema = undefined;
		try {
			desc_schema = await schema_describe.describeSchema(DESCRIBE_SCHEMA_MESSAGE);
		} catch (err) {
			desc_schema = err;
		}
		assert.strictEqual(desc_schema instanceof Error, true, 'expected exception');
		get_db_rw();
	});

	it('describeSchema, test descTable exception', async function () {
		let desc_table_stub_throw = sandbox.stub().throws(new Error('descTable error'));
		schema_describe.__set__('descTable', desc_table_stub_throw);
		let desc_schema = undefined;
		try {
			desc_schema = await schema_describe.describeSchema(DESCRIBE_SCHEMA_MESSAGE);
		} catch (err) {
			desc_schema = err;
		}
		assert.strictEqual(Object.keys(desc_schema).length, 0, 'expected empty results');
		// restore the original search
		schema_describe.__set__('descTable', desc_table_orig);
	});

	it('describeSchema, validation failure', async function () {
		let desc_table_stub_throw = sandbox.stub().throws(new Error('descTable error'));
		schema_describe.__set__('descTable', desc_table_stub_throw);
		let desc_schema = undefined;
		try {
			desc_schema = await schema_describe.describeSchema(null);
		} catch (err) {
			desc_schema = err;
		}
		assert.strictEqual(desc_schema instanceof Error, true, 'expected exception');
		// restore the original search
		schema_describe.__set__('descTable', desc_table_orig);
	});
});

describe('Test describeTable', function () {
	let search_orig = undefined;
	let desc_table_orig = undefined;
	let desc_table_stub = undefined;
	let sandbox = undefined;

	before(async function () {
		test_envs = await test_util.createMockDB(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data);
		desc_table_orig = schema_describe.describeTable;
		sandbox = sinon.createSandbox();
	});

	after(async function () {
		await test_util.tearDownMockDB(test_envs);
		test_envs = [];
		sandbox.restore();
	});

	it('describeTable, test nominal case', async function () {
		let desc_table = await schema_describe.describeTable(DESCRIBE_TABLE_MESSAGE);
		assert.strictEqual(desc_table.name, TEST_TABLE_DOG, 'expected table not found');
		assert(desc_table.last_updated_record >= start_time, 'Has recent updated timestamp');
	});

	it('describeTable, test validation failure', async function () {
		let result = undefined;
		try {
			result = await schema_describe.describeTable(null);
		} catch (err) {
			result = err;
		}
		assert.deepStrictEqual(result instanceof Error, true, 'expected validation failure');
		try {
			result = await schema_describe.describeTable({});
		} catch (err) {
			result = err;
		}
		assert.deepStrictEqual(result.message, 'Table is required');
	});
});
