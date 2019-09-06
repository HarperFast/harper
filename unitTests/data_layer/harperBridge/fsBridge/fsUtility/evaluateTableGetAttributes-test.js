'use strict';

const test_utils = require('../../../../test_utils');

let evaluateTableGetAttributes = require('../../../../../data_layer/harperBridge/fsBridge/fsUtility/evaluateTableGetAttributes');
const chai = require('chai');
const { expect } = chai;

const { TEST_DATA_DOG } = require('../../../../test_data');
let test_attr_names;
const TEST_GLOBAL_ATTR = [
    { "attribute": "age" },
    { "attribute": "breed" },
    { "attribute": "id" },
    { "attribute": "name" }
];
const GET_ALL_ATTRS = ["*"];

function setupTestData() {
    const test_data = test_utils.deepClone(TEST_DATA_DOG);
    test_attr_names = Object.keys(test_data[0]);
}

describe('Test evaluateTableGetAttributes function', () => {
    before(() => {
        setupTestData();
    });

    it('Should return all attr names from global schema if * is passed in',() => {
        const test_result = evaluateTableGetAttributes(GET_ALL_ATTRS, TEST_GLOBAL_ATTR);

        expect(test_result.length).to.equal(TEST_GLOBAL_ATTR.length);
        expect(test_result.sort()).to.deep.equal(test_attr_names.sort());
    });

    it('Should filter out duplicate attributes from from global schema if * is passed in',() => {
        const test_global_attrs_dups = test_utils.deepClone(TEST_GLOBAL_ATTR);
        test_global_attrs_dups.push({ "attribute": "age" });
        test_global_attrs_dups.push({ "attribute": "id" });
        const test_result = evaluateTableGetAttributes(GET_ALL_ATTRS, test_global_attrs_dups);

        expect(test_result.length).to.equal(TEST_GLOBAL_ATTR.length);
        expect(test_result.sort()).to.deep.equal(test_attr_names.sort());
    });

    it('Should return get_attributes if specific values are passed in',() => {
        const test_result = evaluateTableGetAttributes(test_attr_names, TEST_GLOBAL_ATTR);

        expect(test_result.length).to.equal(test_attr_names.length);
        expect(test_attr_names).to.equal(test_attr_names);
    });
});
