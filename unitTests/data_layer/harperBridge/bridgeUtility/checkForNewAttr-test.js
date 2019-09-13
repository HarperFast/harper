'use strict';

const test_utils = require('../../../test_utils');
test_utils.preTestPrep();

const checkForNewAttributes = require('../../../../data_layer/harperBridge/bridgeUtility/checkForNewAttr');
const chai = require('chai');
const { expect } = chai;

const TABLE_SCHEMA_TEST = {
    id: "b6d31ad5",
    name: "dog",
    hash_attribute: "id",
    schema: "dev",
    attributes: []
};

const NO_NEW_ATTR_TEST = [
    {
        attribute: "breed"
    },
    {
        attribute: "name"
    },
    {
        attribute: "age"
    },
    {
        attribute: "id"
    }
];

const DATA_ATTR_TEST = [
    "name",
    "breed",
    "id",
    "age"
];

describe('Tests for bridge utility module checkForNewAttr', () => {
    it('Test function returns early if data attributes empty', () => {
        let result = checkForNewAttributes(TABLE_SCHEMA_TEST, []);

        expect(result).to.be.undefined;
    });
    
    it('Test that nothing is returned if there are no new attributes', () => {
        let table_schema = test_utils.deepClone(TABLE_SCHEMA_TEST);
        table_schema.attributes = NO_NEW_ATTR_TEST;
        let result = checkForNewAttributes(table_schema, DATA_ATTR_TEST);

        expect(result).to.be.undefined;
    });

    it('Test that array of new attributes is returned', () => {
        let result = checkForNewAttributes(TABLE_SCHEMA_TEST, DATA_ATTR_TEST);

        expect(result).to.eql(DATA_ATTR_TEST);
    });
});
