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
    get_attributes: "*"
};

const ERR_MSGS = {
    SCHEMA: "Schema can't be blank",
    TABLE: "Table can't be blank",
    S_ATTR: "Search attribute can't be blank",
    S_VAL: "Search value can't be blank",
    GET_ATTR: "Get attributes can't be blank"
}

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

describe('fsGetDataByHash', () => {

    before(() => {
        setupTestData();
    });

    after(() => {
        tearDownMockFS();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsGetDataByValue');
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

        expect(err.message).to.equal("Schema can't be blank,Table can't be blank,Search attribute can't be blank,Search value can't be blank,Get attributes can't be blank");
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

        expect(err.message).to.equal(ERR_MSGS.S_ATTR);
    }));

    it('Should return error if empty string is passed in for search value', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
        TEMP_SEARCH_OBJECT.search_value = '';
        let err;

        try{
            await fsGetDataByValue_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.S_VAL);
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

        expect(err.message).to.equal(ERR_MSGS.S_VAL);
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

        expect(err.message).to.equal(ERR_MSGS.GET_ATTR);
    }));
});
