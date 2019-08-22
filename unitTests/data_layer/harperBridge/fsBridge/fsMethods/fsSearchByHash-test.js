'use strict';

const test_utils = require('../../../../test_utils');
const {
    deepClone,
    mochaAsyncWrapper,
    preTestPrep
} = test_utils;

preTestPrep();

const rewire = require('rewire');
let fsSearchByHash = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsSearchByHash');
const chai = require('chai');
const { expect } = chai;
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
    get_attributes: "*"
};

const test_search_result_stub = {
    '1': { stuff: 'things'},
    '2': { stuff: 'things'},
    '3': { stuff: 'things'},
    '4': { stuff: 'things'}
}

function setupTestSpies() {
    sandbox = sinon.createSandbox()
    fsGetDataByHash_stub = sandbox.stub().returns(test_search_result_stub);
    fsSearchByHash.__set__('fsGetDataByHash', fsGetDataByHash_stub);
}

describe('fsGetDataByHash', () => {
    before(() => {
        setupTestSpies();
    });

    after(() => {
        sandbox.reset();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsSearchByHash');
    });

    context('Test fsSearchByHash function', () => {

        it('Should return an array with objects from object of objects returned from fsGetDataByHash', mochaAsyncWrapper(async () => {
            const test_expected_result = Object.values(test_search_result_stub);
            const test_search_result = await fsSearchByHash(TEST_SEARCH_OBJ);

            expect(test_search_result).to.deep.equal(test_expected_result);
            expect(test_search_result.length).to.equal(test_expected_result.length);
        }));

    });
});
