'use strict';

const test_utils = require('../../../../test_utils');
const { mochaAsyncWrapper } = test_utils;

const rewire = require('rewire');
let fsSearchByValue = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsSearchByValue');
const { expect } = require('chai');
const sinon = require('sinon');

let sandbox;
let fsGetDataByValue_stub;

const TEST_SCHEMA = 'dev';
const TEST_TABLE_DOG = 'dog';
const test_search_value = 'things';
const test_search_attr = 'stuff';

const TEST_SEARCH_OBJ = {
    operation: "search_by_value",
    schema: TEST_SCHEMA,
    table: TEST_TABLE_DOG,
    search_attribute: test_search_attr,
    search_value: test_search_value,
    get_attributes: ["stuff"]
};

const test_search_result_stub = {
    '1': { stuff: 'things'},
    '2': { stuff: 'things'},
    '3': { stuff: 'things'},
    '4': { stuff: 'things'}
}

function setupTestStub() {
    sandbox = sinon.createSandbox()
    fsGetDataByValue_stub = sandbox.stub().returns(test_search_result_stub);
    fsSearchByValue.__set__('fsGetDataByValue', fsGetDataByValue_stub);
}

describe('fsSearchByValue', () => {
    before(() => {
        setupTestStub();
    });

    after(() => {
        sandbox.reset();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsSearchByValue');
    });

    it('Should return an array with objects from object of objects returned from fsGetDataByHash', mochaAsyncWrapper(async () => {
        const test_expected_result = Object.values(test_search_result_stub);
        const test_search_result = await fsSearchByValue(TEST_SEARCH_OBJ);

        expect(test_search_result).to.deep.equal(test_expected_result);
        expect(test_search_result.length).to.equal(test_expected_result.length);
    }));
});
