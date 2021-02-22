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

const { expect } = require('chai');
const rewire = require('rewire');
const fsGetDataByHash_rw = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsGetDataByHash');

const { TEST_DATA_DOG } = require('../../../../test_data');
const TEST_SCHEMA = 'dev';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_DOG = 'dog';

let test_data_dog;
let test_hash_values = [];
let test_attr_names;

const TEST_SEARCH_OBJ = {
    operation: "search_by_hash",
    schema: TEST_SCHEMA,
    table: TEST_TABLE_DOG,
    hash_values: test_hash_values,
    get_attributes: ['*']
};

const ERR_MSGS = {
    SCHEMA: '"schema" is not allowed to be empty',
    TABLE: '"table" is not allowed to be empty',
    HASHES: '"hash_values" must be an array',
    HASHES_2: '"hash_values" must contain at least 1 items',
    GET_ATTR: '"get_attributes" must be an array',
    GET_ATTR_2: '"get_attributes" does not contain 1 required value(s). "get_attributes" must contain at least 1 items'
};

function setupTestData() {
    const test_data = deepClone(TEST_DATA_DOG);
    test_attr_names = Object.keys(test_data[0]);
    test_data_dog = test_data.reduce((acc, row) => {
        acc[row.id] = row;
        if (row.id < 4) {
            test_hash_values.push(row.id);
        }
        return acc;
    }, {});
    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data);
}

describe('fsGetDataByHash', () => {

    before(() => {
        setupTestData();
    });

    after(() => {
        tearDownMockFS();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsGetDataByHash');
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsUtility/getAttributeFileValues');
    });

    it('Should return results for each hash value passed', mochaAsyncWrapper(async () => {
        const test_search_result = await fsGetDataByHash_rw(TEST_SEARCH_OBJ);

        expect(Object.keys(test_search_result).length).to.equal(test_hash_values.length);
        Object.keys(test_search_result).forEach(row_id => {
            const test_hash = parseInt(row_id);
            expect(test_hash).to.equal(test_search_result[row_id].id);
            expect(test_hash_values.includes(test_hash)).to.equal(true);
        });
    }));

    it('Should return correct attributes for each hash value passed', mochaAsyncWrapper(async () => {
        const test_search_result = await fsGetDataByHash_rw(TEST_SEARCH_OBJ);

        Object.keys(test_search_result).forEach(row_id => {
            expect(test_hash_values.includes(parseInt(row_id))).to.equal(true);
            Object.keys(test_search_result[row_id]).forEach(attr_name => {
                expect(test_data_dog[row_id][attr_name]).to.equal(test_search_result[row_id][attr_name]);
            });
        });
    }));

    it('Should return specified attributes for each hash value passed', mochaAsyncWrapper(async () => {
        const test_attr_name = test_attr_names[0];
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.get_attributes = [test_attr_name];

        const test_search_result = await fsGetDataByHash_rw(TEST_SEARCH_OBJ);

        expect(Object.keys(test_search_result).length).to.equal(test_hash_values.length);
        Object.keys(test_search_result).forEach(row_id => {
            Object.keys(test_search_result[row_id]).forEach(attr_name => {
                expect(test_attr_names.includes(attr_name)).to.equal(true);
                expect(test_search_result[row_id][attr_name]).to.equal(test_data_dog[row_id][attr_name]);
            });
        });
    }));

    it('Should return error if empty object is passed in', mochaAsyncWrapper(async () => {
        let err;
        try{
            await fsGetDataByHash_rw({});
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal('"schema" is required. "table" is required. "hash_values" is required. "get_attributes" is required');
    }));

    it('Should return error if empty string is passed in for schema', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.schema = "";
        let err;

        try{
            err = await fsGetDataByHash_rw(TEMP_SEARCH_OBJECT);
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
            err = await fsGetDataByHash_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.TABLE);
    }));

    it('Should return error if empty string is passed in for hashes', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.hash_values = "";
        let err;

        try{
            err = await fsGetDataByHash_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.HASHES);
    }));

    it('Should return error if empty array is passed in for hash_values', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.hash_values = [];
        let err;

        try{
            await fsGetDataByHash_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.HASHES_2);
    }));

    it('Should return error if empty string is passed in for get_attributes', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.get_attributes = "";
        let err;

        try{
            err = await fsGetDataByHash_rw(TEMP_SEARCH_OBJECT);
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
            err = await fsGetDataByHash_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.GET_ATTR_2);
    }));
});
