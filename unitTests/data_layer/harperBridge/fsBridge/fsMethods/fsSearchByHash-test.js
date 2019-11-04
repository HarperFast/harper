'use strict';

const test_utils = require('../../../../test_utils');
const { mochaAsyncWrapper } = test_utils;

const rewire = require('rewire');
let fsSearchByHash_rw = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsSearchByHash');
const { expect } = require('chai');
const sinon = require('sinon');

let sandbox;
let fsGetDataByHash_stub;

const TEST_SCHEMA = 'dev';
const TEST_TABLE_DOG = 'dog';
let test_hash_values = [1,2,3];

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

function setupTestStub() {
    sandbox = sinon.createSandbox()
    fsGetDataByHash_stub = sandbox.stub().returns(test_search_result_stub);
    fsSearchByHash_rw.__set__('fsGetDataByHash', fsGetDataByHash_stub);
}

describe('fsSearchByHash', () => {
    before(() => {
        setupTestStub();
    });

    after(() => {
        sandbox.reset();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsSearchByHash');
    });

    it('Should return an array with objects from object of objects returned from fsGetDataByHash', mochaAsyncWrapper(async () => {
        const test_expected_result = Object.values(test_search_result_stub);
        const test_search_result = await fsSearchByHash_rw(TEST_SEARCH_OBJ);

        expect(test_search_result).to.deep.equal(test_expected_result);
        expect(test_search_result.length).to.equal(test_expected_result.length);
    }));

    it('Should catch throw error from fsGetDataByHash', mochaAsyncWrapper(async () => {
        const error_msg = "This is an error msg";
        fsGetDataByHash_stub = sandbox.stub().throws(new Error(error_msg));
        fsSearchByHash_rw.__set__('fsGetDataByHash', fsGetDataByHash_stub);

        let test_search_result;
        try {
            await fsSearchByHash_rw(TEST_SEARCH_OBJ);
        } catch(err) {
            test_search_result = err;
        }

        expect(test_search_result.message).to.equal(error_msg);
        expect(test_search_result instanceof Error).to.equal(true);
    }));

});
