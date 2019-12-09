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
    before(async function() {
        await test_util.createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data);
    });

    after(async function() {
        await test_util.tearDownMockFS();
    });

    it('describeAll, test nominal case', async function () {
        let all_schema = await schema_describe.describeAll();
        assert.strictEqual(Object.keys(all_schema).length, 1, 'expected schema not found');
    });

    it('describeAll, test search exception', async function () {
        let search_stub_throw = sinon.stub().throws('search error');
        let search_orig = schema_describe.__get__('p_search_search_by_value');
        schema_describe.__set__('p_search_search_by_value', search_stub_throw);
        let all_schema = await schema_describe.describeAll();
        assert.strictEqual((all_schema instanceof Error), true, 'expected exception');
        schema_describe.__set__('p_search_search_by_value', search_orig);
    });
});

describe('Test describeSchema', function() {
    before(async function() {
        await test_util.createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data);
    });

    after(async function() {
        await test_util.tearDownMockFS();
    });

    it('describeSchema, test nominal case', async function () {
        let desc_schema = await schema_describe.describeSchema(DESCRIBE_SCHEMA_MESSAGE);
        assert.strictEqual(Object.keys(desc_schema).length, 1, 'expected schema not found');
    });

    it('describeSchema, test nominal case', async function () {
        let desc_schema = await schema_describe.describeSchema(DESCRIBE_SCHEMA_MESSAGE);
        //assert.strictEqual(Object.keys(desc_schema).length, 1, 'expected schema not found');
    });
});

describe('Test describeTable', function() {
    before(async function() {
        await test_util.createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data);
    });

    after(async function() {
        await test_util.tearDownMockFS();
    });

    it('describeSchema, test nominal case', async function () {
        let desc_table = await schema_describe.describeTable(DESCRIBE_TABLE_MESSAGE);
        assert.strictEqual(desc_table.name, TEST_TABLE_DOG, 'expected table not found');
    });
});