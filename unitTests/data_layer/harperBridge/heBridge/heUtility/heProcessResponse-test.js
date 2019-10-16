'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const heProcessInsertUpdateResponse = require('../../../../../data_layer/harperBridge/heBridge/heUtility/heProcessResponse');
const hdb_terms = require('../../../../../utility/hdbTerms');
const chai = require('chai');
const { expect } = chai;

const HE_RESPONSE_A = [ [ "123", "1232" ], [ [ "8", [ -122, "HE_ERR_ITEM_EXISTS" ] ],  ["9", [ -122, "HE_ERR_ITEM_EXISTS" ] ] ]];
const HE_RESPONSE_B = [ ['34', '43', '77'] , []];
const HE_RESPONSE_BAD = [ [ "6" ], [ [ "5", [ -101, "Row[0] contains different number of elements(3) than the number of columns(4) specified." ] ] ] ];

describe('Tests for heUtility module heProcessResponse', () => {
    
    it('Test for nominal behaviour from Helium response A', () => {
        let expected_result = {
            written_hashes: [ 123, 1232 ],
            skipped_hashes: [ 8, 9 ]
        };
        let result = heProcessInsertUpdateResponse(HE_RESPONSE_A, hdb_terms.OPERATIONS_ENUM.INSERT);

        expect(result).to.eql(expected_result);
    });

    it('Test for nominal behaviour from Helium response B', () => {
        let expected_result = {
            written_hashes: [ 34, 43, 77 ],
            skipped_hashes: []
        };
        let result = heProcessInsertUpdateResponse(HE_RESPONSE_B, hdb_terms.OPERATIONS_ENUM.INSERT);

        expect(result).to.eql(expected_result);
    });

    it('Test that error code is thrown if not accepted', () => {
        let error;
        try {
            heProcessInsertUpdateResponse(HE_RESPONSE_BAD, hdb_terms.OPERATIONS_ENUM.INSERT);
        } catch(err) {
            error = err;
        }

        expect(error.message).to.equal("Row[0] contains different number of elements(3) than the number of columns(4) specified.");
        expect(error).to.be.an.instanceOf(Error);
    });

    it('Test for nominal behaviour deleting', () => {
        let expected_result = {
            deleted_hashes: [ 123, 1232 ],
            skipped_hashes: [ 8, 9 ],
            message: '2 records successfully deleted'
        };
        let result = heProcessInsertUpdateResponse(HE_RESPONSE_A, hdb_terms.OPERATIONS_ENUM.DELETE);

        expect(result).to.eql(expected_result);
    });
});
