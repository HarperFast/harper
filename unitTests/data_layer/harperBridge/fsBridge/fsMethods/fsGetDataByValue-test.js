'use strict';

const test_utils = require('../../../../test_utils');
const {
    createMockFS,
    deepClone,
    mochaAsyncWrapper,
    tearDownMockFS,
    preTestPrep
} = test_utils;

preTestPrep();

const rewire = require('rewire');
let fsGetDataByValue_rw = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsGetDataByValue');
const assert = require('assert');
const SearchObject = require('../../../../../data_layer/SearchObject');
const { expect } = require('chai');

const { TEST_DATA_DOG } = require('../../../../test_data');
const TEST_SCHEMA = 'dev';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_DOG = 'dog';

let test_data_dog;
let test_search_attr = 'breed';
const test_search_value = 'Pit';
let test_attr_names;
const test_expected_hash_result = [];

const TEST_SEARCH_OBJ = {
    operation: "search_by_value",
    schema: TEST_SCHEMA,
    table: TEST_TABLE_DOG,
    search_attribute: test_search_attr,
    search_value: `${test_search_value}*`,
    get_attributes: ['*']
};

const ERR_MSGS = {
    SCHEMA: '"schema" is not allowed to be empty',
    TABLE: '"table" is not allowed to be empty',
    S_ATTR: '"search_attribute" is not allowed to be empty',
    S_ATTR_STR: '"search_attribute" must be one of [string, number]',
    S_VAL: "Search value can't be blank",
    GET_ATTR: '"get_attributes" must be an array',
    GET_ATTR_2: '"get_attributes" does not contain 1 required value(s). "get_attributes" must contain at least 1 items'
};

function setupTestData() {
    const test_data = deepClone(TEST_DATA_DOG);
    test_attr_names = Object.keys(test_data[0]);
    test_data_dog = test_data.reduce((acc, row) => {
        acc[row.id] = row;
        if (row.breed.includes(test_search_value)) {
            test_expected_hash_result.push(row.id);
        }
        return acc;
    }, {});
    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data);
}

describe('fsGetDataByValue', () => {

    before(() => {
        setupTestData();
    });

    after(() => {
        tearDownMockFS();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsGetDataByValue');
    });

    it('test schema validation', async()=>{
        await test_utils.testHDBError(fsGetDataByValue_rw({schema:'dev2', table:'dog', search_attribute: 'city', search_value: '*', get_attributes:['*']}), test_utils.generateHDBError("Schema 'dev2' does not exist", 404));
        await test_utils.testHDBError(fsGetDataByValue_rw({schema:'dev', table:'fake', search_attribute: 'city', search_value: '*', get_attributes:['*']}), test_utils.generateHDBError("Table 'dev.fake' does not exist", 404));
        await test_utils.assertErrorAsync(fsGetDataByValue_rw, [{schema:'dev', table:'dog', search_attribute: 'fake_city', search_value: '*', get_attributes:['*']}], new Error("unknown attribute 'fake_city'"));
        await test_utils.assertErrorAsync(fsGetDataByValue_rw, [{schema:'dev', table:'dog', search_attribute: 'id', search_value: '*', get_attributes:['id','fake']}], new Error("unknown attribute 'fake'"));
    });

    it('Should return results for each hash value passed', mochaAsyncWrapper(async () => {
        const test_search_result = await fsGetDataByValue_rw(TEST_SEARCH_OBJ);

        expect(Object.keys(test_search_result).length).to.equal(test_expected_hash_result.length);
        Object.keys(test_search_result).forEach(row_id => {
            const test_hash = parseInt(row_id);
            expect(test_hash).to.equal(test_search_result[row_id].id);
            expect(test_expected_hash_result.includes(test_hash)).to.equal(true);
        });
    }));

    it('Should return correct attributes for each matching row', mochaAsyncWrapper(async () => {
        const test_search_result = await fsGetDataByValue_rw(TEST_SEARCH_OBJ);

        Object.keys(test_search_result).forEach(row_id => {
            expect(test_expected_hash_result.includes(parseInt(row_id))).to.equal(true);
            Object.keys(test_search_result[row_id]).forEach(attr_name => {
                expect(test_data_dog[row_id][attr_name]).to.equal(test_search_result[row_id][attr_name]);
            });
        });
    }));

    it('Should return specified attributes for each matching row', mochaAsyncWrapper(async () => {
        const test_attr_name = test_attr_names[0];
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.get_attributes = [test_attr_name];

        const test_search_result = await fsGetDataByValue_rw(TEMP_SEARCH_OBJECT);

        expect(Object.keys(test_search_result).length).to.equal(test_expected_hash_result.length);
        Object.keys(test_search_result).forEach(row_id => {
            expect(test_expected_hash_result.includes(parseInt(row_id))).to.equal(true);
            Object.keys(test_search_result[row_id]).forEach(attr_name => {
                expect(test_attr_names.includes(attr_name)).to.equal(true);
                expect(test_search_result[row_id][attr_name]).to.equal(test_data_dog[row_id][attr_name]);
            });
        });
    }));

    it('Should return error if empty object is passed in', mochaAsyncWrapper(async () => {
        let err;
        try{
            await fsGetDataByValue_rw({});
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal('"schema" is required. "table" is required. "search_attribute" is required. "search_value" is required. "get_attributes" is required');
    }));

    it('Should return error if empty string is passed in for schema', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.schema = "";
        let err;

        try{
            err = await fsGetDataByValue_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.SCHEMA);
    }));

    it('Should return error if empty string is passed in for table', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.table = "";
        let err;

        try{
            err = await fsGetDataByValue_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.TABLE);
    }));

    it('Should return error if empty string is passed in for search attribute', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.search_attribute = "";
        let err;

        try{
            err = await fsGetDataByValue_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.S_ATTR);
    }));

    it('Should return error if empty object is passed in for search attribute', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.search_attribute = {};
        let err;

        try{
            err = await fsGetDataByValue_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.S_ATTR_STR);
    }));

    it('Should NOT return error if empty string is passed in for search value', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.search_value = '';
        let err;

        try{
            await fsGetDataByValue_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err).to.equal(undefined);
    }));

    it('Should return error if empty array is passed in for search value', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.search_value = [];
        let err;

        try{
            await fsGetDataByValue_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err).to.equal(undefined);
    }));

    it('Should return error if empty string is passed in for get_attributes', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.get_attributes = "";
        let err;

        try{
            err = await fsGetDataByValue_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.GET_ATTR);
    }));

    it('Should return error if empty array is passed in for get_attributes', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.get_attributes = [];
        let err;

        try{
            err = await fsGetDataByValue_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.GET_ATTR_2);
    }));

    it('test search value is json', async()=>{
        let record = {id:'jsontest', breed:{cool:true}};
        test_utils.createMockFS('id', TEST_SCHEMA, TEST_TABLE_DOG, [test_utils.deepClone(record)]);

        let search_object = new SearchObject('dev', 'dog', 'breed', record.breed, 'id', ['id', 'breed']);
        let err = undefined;
        let result = undefined;
        try{
            result = await fsGetDataByValue_rw(search_object);
        } catch(e) {
            err = e;
        }

        expect(err).to.equal(undefined);

        let expected = {
            [record.id]: record
        };
        assert.deepEqual(result, expected);
    });

    it('test search value is array', async()=>{
        let record = {id:'arraytest', breed:['awesome', 'great']};

        test_utils.createMockFS('id', TEST_SCHEMA, TEST_TABLE_DOG, [test_utils.deepClone(record)]);

        let search_object = new SearchObject('dev', 'dog', 'breed', record.breed, 'id', ['id', 'breed']);
        let err = undefined;
        let result = undefined;
        try{
            result = await fsGetDataByValue_rw(search_object);
        } catch(e) {
            err = e;
        }

        expect(err).to.equal(undefined);

        let expected = {
            [record.id]: record
        };
        assert.deepEqual(result, expected);
    });
});
