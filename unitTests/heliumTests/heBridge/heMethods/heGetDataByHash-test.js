'use strict';

const test_utils = require('../../../test_utils');
test_utils.preTestPrep();

const harperdb_helium = require('../../../../dependencies/harperdb_helium/hdb').default;
global.hdb_helium = new harperdb_helium(false);

const rewire = require('rewire');
const heGetDataByHash_rw = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heGetDataByHash');
const heGenerateDataStoreName = require('../../../../data_layer/harperBridge/heBridge/heUtility/heGenerateDataStoreName');
const evaluateTableGetAttributes = require('../../../../data_layer/harperBridge/bridgeUtility/evaluateTableGetAttributes');

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
let sandbox;
let heSearchReturnData_stub;
let heSearchReturnErr_stub;
let search_validator_rw;
let evaluateTableGetAttributes_stub;
let heGenerateDataStoreName_stub;
let consolidateHashSearchData_stub;
let consolidateHashSearchData_rw;

const { TEST_DATA_DOG } = require('../../../test_data');
const TEST_SCHEMA = 'dev';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_DOG = 'dog';

let test_he_return;
let test_expected_result = {};
let test_hash_values = [];
let test_attr_names;
let test_datastores;

const TEST_SEARCH_OBJ = {
    operation: "search_by_hash",
    schema: TEST_SCHEMA,
    table: TEST_TABLE_DOG,
    hash_values: test_hash_values,
    get_attributes: "*"
};

const ERR_MSGS = {
    SCHEMA: "Schema can't be blank",
    TABLE: "Table can't be blank",
    HASHES: "Hash values can't be blank",
    GET_ATTR: "Get attributes can't be blank"
};

function setupTestData() {
    const test_data = test_utils.deepClone(TEST_DATA_DOG);
    test_data.forEach(row => {
        test_expected_result[row.id] = Object.assign(row, {test_null_attr: null});
    });
    test_attr_names = Object.keys(test_data[0]);
    test_he_return = test_data.reduce((acc, row, i) => {
        test_hash_values.push(row.id);
        const row_data = []
        row_data.push(row.id);
        row_data.push([]);
        test_attr_names.forEach(key => {
            row_data[1].push(row[key]);
        });
        // row_data[1].push(null);
        acc.push(row_data);
        return acc;
    }, []);
    // test_attr_names.push('test_null_attr');
    test_datastores = test_attr_names.map(attr => heGenerateDataStoreName(TEST_SCHEMA, TEST_TABLE_DOG, attr));
}

function setupInitialTestSpies() {
    sandbox = sinon.createSandbox();
    heSearchReturnData_stub = sandbox.stub().returns(test_he_return);
    heGetDataByHash_rw.__set__('hdb_helium', {searchByKeys: heSearchReturnData_stub});

    search_validator_rw = heGetDataByHash_rw.__get__('search_validator');
    evaluateTableGetAttributes_stub = sandbox.stub().callsFake(evaluateTableGetAttributes);
    heGenerateDataStoreName_stub = sandbox.stub().callsFake(heGenerateDataStoreName);
    consolidateHashSearchData_rw = heGetDataByHash_rw.__get__('consolidateHashSearchData');
    consolidateHashSearchData_stub = sandbox.stub().callsFake(consolidateHashSearchData_rw);

    heGetDataByHash_rw.__set__('evaluateTableGetAttributes', evaluateTableGetAttributes_stub);
    heGetDataByHash_rw.__set__('heGenerateDataStoreName', heGenerateDataStoreName_stub);
    heGetDataByHash_rw.__set__('consolidateHashSearchData', consolidateHashSearchData_stub);
}

describe('Test for Helium method heGetDataByHash', () => {

    before(() => {
        setupTestData();
        setupInitialTestSpies();
        global.hdb_schema = {
            [TEST_SCHEMA]: {
                [TEST_TABLE_DOG]: {
                    schema: TEST_SCHEMA,
                    name: TEST_TABLE_DOG,
                    attributes: [{attribute: 'age'}, {attribute: 'breed'}, {attribute: 'id'}, {attribute: 'name'}, {attribute: 'test_null_attr'}]
                }
            },
        };
    });

    afterEach(() => {
        sandbox.resetHistory();
    })

    after(() => {
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heGetDataByHash');
        global.harperdb_helium = undefined;
    });

    it('Should consolidate final search data into an object of row data objects', () => {
        let test_search_result;
        try {
            test_search_result = heGetDataByHash_rw(TEST_SEARCH_OBJ);
        } catch(e){
            console.log(e);
        }

        expect(test_search_result).to.deep.equal(test_expected_result);
    });

    it('Should generate a datastore name for each get_attribute', () => {
        try {
            heGetDataByHash_rw(TEST_SEARCH_OBJ);
        } catch(e){
            console.log(e);
        }

        expect(heGenerateDataStoreName_stub.callCount).to.equal(test_attr_names.length);
    });

    describe('consolidateSearchData tests', () => {
        it('Should consolidate results from helium into object of row objects', () => {
            let test_search_result;
            try {
                test_search_result = consolidateHashSearchData_rw(test_attr_names, test_he_return);
            } catch(err) {
                console.log(err);
            }

            expect(test_search_result).to.deep.equal(test_expected_result);
        });
    })

    describe('Exception tests',() => {

        it('Should return validation error',() => {
            const validation_error = 'Validation error message';
            heGetDataByHash_rw.__set__('search_validator', () => new Error(validation_error));

            let test_search_result;
            try {
                heGetDataByHash_rw(TEST_SEARCH_OBJ);
            } catch(err) {
                test_search_result = err;
            }

            expect(test_search_result.message).to.equal(validation_error);

            heGetDataByHash_rw.__set__('search_validator', search_validator_rw);
        });

        it('Should catch an error if helium throws one',() => {
            const search_err_msg = 'This is an error msg';
            heSearchReturnErr_stub = sandbox.stub().throws(new Error(search_err_msg));
            heGetDataByHash_rw.__set__('hdb_helium', {searchByKeys: heSearchReturnErr_stub});

            let test_search_result;
            try {
                heGetDataByHash_rw(TEST_SEARCH_OBJ);
            } catch(err) {
                test_search_result = err;
            }

            expect(test_search_result.message).to.equal(search_err_msg);

            heGetDataByHash_rw.__set__('hdb_helium', {searchByKeys: heSearchReturnData_stub});
        });
    })
});
