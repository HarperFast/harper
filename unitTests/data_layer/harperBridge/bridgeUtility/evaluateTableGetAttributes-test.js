'use strict';
//
// const test_utils = require('../../../test_utils');
// test_utils.preTestPrep();

const evaluateTableGetAttributes = require('../../../../data_layer/harperBridge/bridgeUtility/evaluateTableGetAttributes');
const chai = require('chai');
const { expect } = chai;

let TEST_GET_ATTRS;

const TEST_TABLE_ATTR_OBJS = [
    {
        attribute: "age"
    },
    {
        attribute: "breed"
    },
    {
        attribute: "id"
    },
    {
        attribute: "name"
    }
];

const TEST_TABLE_ATTRS = [
    "age",
    "breed",
    "id",
    "name"
];

describe('Tests for bridge utility module evaluateTableGetAttributes', () => {

    it('function should return get_attributes if no star is included in initial string argument', () => {
        TEST_GET_ATTRS = ['id', 'name'];

        const test_result = evaluateTableGetAttributes(TEST_GET_ATTRS, TEST_TABLE_ATTR_OBJS);

        expect(test_result).to.deep.equal(TEST_GET_ATTRS);
    });

    it('function should return all table attributes if ["*"] is included as get_attr argument', () => {
        TEST_GET_ATTRS = ['*'];

        const test_result = evaluateTableGetAttributes(TEST_GET_ATTRS, TEST_TABLE_ATTR_OBJS);

        expect(test_result).to.deep.equal(TEST_TABLE_ATTRS);
    });

    it('function should return all unique table attributes if * and other attribute values are included as get_attr argument', () => {
        TEST_GET_ATTRS = ["*", "age", "breed", "id"];

        const test_result = evaluateTableGetAttributes(TEST_GET_ATTRS, TEST_TABLE_ATTR_OBJS);

        expect(test_result).to.deep.equal(TEST_TABLE_ATTRS);
    });
});
