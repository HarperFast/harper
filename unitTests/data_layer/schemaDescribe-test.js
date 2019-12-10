'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();
const env = require('../../utility/environment/environmentManager');
const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
// need to rewire in order to override p_search_search_by_value
const schema_describe = rewire('../../data_layer/schemaDescribe');

const TEST_DATA_DOG = [
    {
        "age": 5,
        "breed": "Mutt",
        "id": 1,
        "name": "Sam"
    },
    {
        "age": 4,
        "breed": "Golden Retriever",
        "id": 2,
        "name": "David"
    },
    {
        "age": 10,
        "breed": "Pit Bull",
        "id": 3,
        "name": "Kyle"
    },
    {
        "age": 10,
        "breed": "Pit",
        "id": 4,
        "name": "Sam"
    },
    {
        "age": 15,
        "breed": "Poodle",
        "id": 5,
        "name": "Eli"
    },
    {
        "age": 8,
        "breed": "Poodle",
        "id": 6,
        "name": "Sarah"
    }
];

let SEARCH_STUB_RESULTS = [
    {
        "id": "6e175c63-575c-4f0c-beb0-0586a4fbcaf3",
        "name": "dog",
        "hash_attribute": "id",
        "schema": "dev",
        "residence": null
    }
];

const test_data = test_util.deepClone(TEST_DATA_DOG);
const TEST_SCHEMA = 'dev';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_DOG = 'dog';

const DESCRIBE_SCHEMA_MESSAGE = {
    "operation":"describe_schema",
    "schema":`${TEST_SCHEMA}`
};

const DESCRIBE_TABLE_MESSAGE = {
    "operation":"describe_schema",
    "schema":`${TEST_SCHEMA}`,
    "table":`${TEST_TABLE_DOG}`
};

describe('Test describeAll', function() {
    let search_orig = undefined;
    let desc_table_orig = undefined;
    let desc_table_stub = undefined;
    let sandbox = undefined;
    before(async function() {
        await test_util.createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data);
        search_orig = schema_describe.__get__('p_search_search_by_value');
        desc_table_orig = schema_describe.describeTable;
        sandbox = sinon.createSandbox();
    });

    after(async function() {
        await test_util.tearDownMockFS();
        desc_table_orig = schema_describe.describeTable;
    });

    it('describeAll, test nominal case', async function () {
        let all_schema = await schema_describe.describeAll();
        assert.strictEqual(Object.keys(all_schema).length, 1, 'expected schema not found');
    });

    it('describeAll, test search exception', async function () {
        let search_stub_throw = sandbox.stub().throws(new Error('search error'));
        schema_describe.__set__('p_search_search_by_value', search_stub_throw);
        let all_schema = await schema_describe.describeAll();
        assert.strictEqual((all_schema instanceof Error), true, 'expected exception');
        // restore the original search
        schema_describe.__set__('p_search_search_by_value', search_orig);
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

describe('Test describeSchema', function() {
    let search_orig = undefined;
    let desc_table_orig = undefined;
    let desc_table_stub = undefined;
    let sandbox = undefined;
    before(async function() {
        await test_util.createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data);
        search_orig = schema_describe.__get__('p_search_search_by_value');
        desc_table_orig = schema_describe.describeTable;
        sandbox = sinon.createSandbox();
    });

    after(async function() {
        await test_util.tearDownMockFS();
        sandbox.restore();
    });

    it('describeSchema, test nominal case', async function () {
        let desc_schema = await schema_describe.describeSchema(DESCRIBE_SCHEMA_MESSAGE);
        assert.strictEqual(Object.keys(desc_schema).length, 1, 'expected schema not found');
    });

    it('describeSchema, test search exception', async function () {
        let search_stub_throw = sandbox.stub().throws(new Error('search error'));
        schema_describe.__set__('p_search_search_by_value', search_stub_throw);
        let desc_schema = undefined;
        try {
            desc_schema = await schema_describe.describeSchema(DESCRIBE_SCHEMA_MESSAGE);
        } catch(err) {
            desc_schema = err;
        }
        assert.strictEqual((desc_schema instanceof Error), true, 'expected exception');
        schema_describe.__set__('p_search_search_by_value', search_orig);
    });

    it('describeSchema, test descTable exception', async function () {
        let desc_table_stub_throw = sandbox.stub().throws(new Error('descTable error'));
        schema_describe.__set__('descTable', desc_table_stub_throw);
        let desc_schema = undefined;
        try {
            desc_schema = await schema_describe.describeSchema(DESCRIBE_SCHEMA_MESSAGE);
        } catch(err) {
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
        } catch(err) {
            desc_schema = err;
        }
        assert.strictEqual((desc_schema instanceof Error), true, 'expected exception');
        // restore the original search
        schema_describe.__set__('descTable', desc_table_orig);
    });
});

describe('Test describeTable', function() {
    let search_orig = undefined;
    let desc_table_orig = undefined;
    let desc_table_stub = undefined;
    let sandbox = undefined;

    before(async function() {
        await test_util.createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data);
        search_orig = schema_describe.__get__('p_search_search_by_value');
        desc_table_orig = schema_describe.describeTable;
        sandbox = sinon.createSandbox();
    });

    after(async function() {
        await test_util.tearDownMockFS();
        sandbox.restore();
    });

    it('describeTable, test nominal case', async function () {
        let desc_table = await schema_describe.describeTable(DESCRIBE_TABLE_MESSAGE);
        assert.strictEqual(desc_table.name, TEST_TABLE_DOG, 'expected table not found');
    });

    it('describeTable, test validation failure', async function () {
        let result = undefined;
        try {
            result = await schema_describe.describeTable(null);
        } catch(err) {
            result = err;
        }
        assert.deepStrictEqual((result instanceof Error), true, 'expected validation failure');
    });

    it('describeTable, test search exception case', async function () {
        let search_stub_throw = sandbox.stub().onCall(0).resolves(SEARCH_STUB_RESULTS);
        search_stub_throw.onCall(1).throws(new Error('Second search exception'));
        schema_describe.__set__('p_search_search_by_value', search_stub_throw);
        let desc_table = await schema_describe.describeTable(DESCRIBE_TABLE_MESSAGE);
        assert.deepStrictEqual(desc_table.name, TEST_TABLE_DOG, 'expected empty results');
    });
});