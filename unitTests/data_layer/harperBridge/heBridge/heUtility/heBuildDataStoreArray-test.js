'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const heBuildDataStoreArray = require('../../../../../data_layer/harperBridge/heBridge/heUtility/heBuildDataStoreArray');
const hdb_terms = require('../../../../../utility/hdbTerms');
const chai = require('chai');
const { expect } = chai;

const ATTRIBUTE_TEST = ['car', 'horse', 'bike', 'boat'];
const SCHEMA_TEST = 'transport';
const TABLE_TEST = 'types';
const LONG_CHAR_TEST = "z2xFuWBiQgjAAAzgAK80e35FCuFzNHpicBWzsWZW055mFHwBxdU5yE5KlTQRzcZ04UlBTdhzDrVn1k1fuQCN9" +
    "faotQUlygf8Hv3E89f2v3KRzAX5FylEKwv4GJpSoZbXpgJ1mhmOjGUCAh3sipI5rVV0yvz6dbkXOw7xE5XlCHBRnc3T6BVyHIlUmFdlBowy" +
    "vAy7MT49mg6wn5yCqPEPFkcva2FNRYSNxljmu1XxN65mTKiTw2lvM0Yl2o0";

describe('Test Helium utility module heBuildDataStoreArray', () => {
    
    it('Test that correct array is returned', () => {
        let expected_result = [
            'transport/types/car',
            'transport/types/horse',
            'transport/types/bike',
            'transport/types/boat'
        ];
        let result = heBuildDataStoreArray(ATTRIBUTE_TEST, SCHEMA_TEST, TABLE_TEST);

        expect(result).to.eql(expected_result);
    });
    
    it('Test error thrown due to attribute name too long', () => {
        let error;

        try {
            heBuildDataStoreArray([LONG_CHAR_TEST], SCHEMA_TEST, TABLE_TEST);
        } catch(err) {
            error = err;
        }

        expect(error).to.be.an.instanceOf(Error);
        expect(error.message).to.equal(
            `transaction aborted due to attribute name ${LONG_CHAR_TEST} being too long. Attribute names cannot be longer than ${hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE} bytes.`);
    });

    it('Test error is thrown if attribute name is empty', () => {
        let error;
        try {
            heBuildDataStoreArray([''], SCHEMA_TEST, TABLE_TEST);
        } catch(err) {
            error = err;
        }

        expect(error).to.be.an.instanceOf(Error);
        expect(error.message).to.equal('transaction aborted due to record(s) with an attribute name that is null, undefined or empty string');
    });
});