'use strict';

let consolidateSearchData = require('../../../../../data_layer/harperBridge/fsBridge/fsUtility/consolidateSearchData');
const chai = require('chai');
const { expect } = chai;
const test_utils = require('../../../../test_utils');

const { TEST_DATA_DOG } = require('../../../../test_data');
const HASH_ATTRIBUTE = 'id';

let test_data_dog;
let test_hash_values = [];
let test_attr_names;
let test_attr_data = {};

//TODO: look into cleaning upp to only build the data needed
function setupTestData() {
    const test_data = test_utils.deepClone(TEST_DATA_DOG);
    test_attr_names = Object.keys(test_data[0]);
    test_data_dog = test_data.reduce((acc, row) => {
        acc[row.id] = row;
        if (row.id < 4) {
            test_hash_values.push(row.id);
        }
        return acc;
    }, {});
    test_attr_names.forEach(attr => {
        test_hash_values.forEach(hash_id => {
            if (!test_attr_data[attr]) {
                test_attr_data[attr] = Object.assign({[hash_id]: test_data_dog[hash_id][attr] });
            } else {
                test_attr_data[attr] = Object.assign(test_attr_data[attr], {[hash_id]: test_data_dog[hash_id][attr] });
            }
        });
    });
}

describe('consolidateSearchData', () => {

    before(() => {
        setupTestData();
    });

    it('Should return an empty object if there is no attribute data passed in', () => {
        const test_result = consolidateSearchData(HASH_ATTRIBUTE, {});

        expect(test_result).to.deep.equal({});
    });

    it('Should return an object of objects with attr value pairs from the attr values passed in', () => {
        const test_result = consolidateSearchData(HASH_ATTRIBUTE, test_attr_data);

        const test_result_keys = Object.keys(test_result);
        expect(test_result_keys.length).to.equal(test_hash_values.length);
    });

    it('Should return an object of objects with attr value pairs from the attr values passed in when hash attr values are not included', () => {
        const test_attr_data_wo_hash = test_utils.deepClone(test_attr_data);
        delete test_attr_data_wo_hash[HASH_ATTRIBUTE]
        const test_result = consolidateSearchData(HASH_ATTRIBUTE, test_attr_data);

        const test_result_keys = Object.keys(test_result);
        expect(test_result_keys.length).to.equal(test_hash_values.length);
    });
});
