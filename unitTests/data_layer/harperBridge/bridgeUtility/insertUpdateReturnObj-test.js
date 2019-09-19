'use strict';
const test_utils = require('../../../test_utils');
test_utils.preTestPrep();

const returnObject = require('../../../../data_layer/harperBridge/bridgeUtility/insertUpdateReturnObj');
const chai = require('chai');
const { expect } = chai;

const WRITTEN_HASH_TEST = ['12', '45'];
const OBJECT_TEST = {
    "operation": "insert",
    "schema": "fast",
    "table": "cars",
    "hash_attribute": "id",
    "records": [
        {
            color: "red",
            make: "toyota",
            id: "12",
        },
        {
            color: "blue",
            make: "toyota",
            id: "45",
        },
        {
            color: "white",
            make: "toyota",
            id: "1",
        }
    ]
} ;
const SKIPPED_TEST = ['1'];

describe('Test bridge utility module insertUpdateReturnObj', () => {
    it('Test for correct result on insert', () => {
        let expected_result = {
            message: 'inserted 2 of 3 records',
            skipped_hashes: [ '1' ],
            inserted_hashes: [ '12', '45' ]
        };
        let result = returnObject('inserted', WRITTEN_HASH_TEST, OBJECT_TEST, SKIPPED_TEST)

        expect(result).to.eql(expected_result);
    });

    it('Test for correct result on update', () => {
        let expected_result = {
            message: 'updated 2 of 3 records',
            skipped_hashes: [ '1' ],
            update_hashes: [ '12', '45' ]
        };
        let result = returnObject('updated', WRITTEN_HASH_TEST, OBJECT_TEST, SKIPPED_TEST)

        expect(result).to.eql(expected_result);
    });
});
