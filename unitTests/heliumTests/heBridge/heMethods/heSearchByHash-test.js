'use strict';

const harperdb_helium = require('../../../../dependencies/harperdb_helium/hdb').default;
global.hdb_helium = new harperdb_helium(false);

const rewire = require('rewire');
let heSearchByHash_rw = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heSearchByHash');
const { expect } = require('chai');
const sinon = require('sinon');

let sandbox;
let heGetDataByHash_stub;

const TEST_SCHEMA = 'dev';
const TEST_TABLE_DOG = 'dog';
let test_hash_values;

const TEST_SEARCH_OBJ = {
    operation: "search_by_hash",
    schema: TEST_SCHEMA,
    table: TEST_TABLE_DOG,
    hash_values: test_hash_values,
    get_attributes: ["*"]
};

const test_search_result_stub = {
    '1': { stuff: 'things'},
    '2': { stuff: 'things'},
    '3': { stuff: 'things'},
    '4': { stuff: 'things'}
};

function setupTestData() {
    sandbox = sinon.createSandbox()
    heGetDataByHash_stub = sandbox.stub().returns(test_search_result_stub);
    heSearchByHash_rw.__set__('heGetDataByHash', heGetDataByHash_stub);
}

describe('heSearchByHash', () => {
    before(() => {
        setupTestData();
    });

    after(() => {
        sandbox.reset();
        rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heSearchByHash');
        global.harperdb_helium = undefined;
    });

    it('Should return an array with objects from object of objects returned from heGetDataByHash',() => {
        const test_expected_result = Object.values(test_search_result_stub);
        const test_search_result = heSearchByHash_rw(TEST_SEARCH_OBJ);

        expect(test_search_result).to.deep.equal(test_expected_result);
        expect(test_search_result.length).to.equal(test_expected_result.length);
    });

    it('Should catch throw error from heGetDataByHash',() => {
        const error_msg = "This is an error msg";
        heGetDataByHash_stub = sandbox.stub().throws(new Error(error_msg));
        heSearchByHash_rw.__set__('heGetDataByHash', heGetDataByHash_stub);

        let test_search_result;
        try {
            heSearchByHash_rw(TEST_SEARCH_OBJ);
        } catch(err) {
            test_search_result = err;
        }

        expect(test_search_result.message).to.equal(error_msg);
        expect(test_search_result instanceof Error).to.equal(true);
    });
});