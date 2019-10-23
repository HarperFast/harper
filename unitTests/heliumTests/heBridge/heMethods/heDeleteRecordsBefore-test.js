'use strict';

const test_utils = require('../../../test_utils');
test_utils.preTestPrep();

const harperdb_helium = require('../../../../dependencies/harperdb_helium/hdb').default;
global.hdb_helium = new harperdb_helium(false);

const rewire = require('rewire');
const heDeleteRecordsBefore = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heDeleteRecordsBefore');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);

const HELIUM_RESPONSE = [
    [ '1571083064650', [ '8' ] ],
    [ '1571083064650', [ '9' ] ],
    [ '1111083064650', [ '100' ] ]
];

const DELETE_OBJ_TEST = {
    operation: "delete_files_before",
    date: `2019-09-12`,
    schema: 'animals',
    table: 'horses'
};

const DELETE_RECORDS_MSG = 'Successfully deleted records';

describe('Test Helium method heDeleteRecordsBefore', () => {
    let sandbox = sinon.createSandbox();
    let hdb_helium_stub = sandbox.stub().returns(HELIUM_RESPONSE);
    let he_delete_records_stub = sandbox.stub().returns('Successfully deleted records');
    heDeleteRecordsBefore.__set__('hdb_helium', {searchByValueRange: hdb_helium_stub});
    heDeleteRecordsBefore.__set__('heDeleteRecords', he_delete_records_stub);

    before(() => {
        global.hdb_schema = {
            [DELETE_OBJ_TEST.schema]: {
                [DELETE_OBJ_TEST.table]: {
                    hash_attribute: ''
                }
            }
        };
    });

    after(() => {
        delete global.hdb_schema[DELETE_OBJ_TEST.schema];
        delete global.harperdb_helium;
        rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heDeleteRecordsBefore');
        sandbox.restore();
    });

    it('Test error is thrown with bad attribute', () => {
        let error;
        try {
            heDeleteRecordsBefore(DELETE_OBJ_TEST);
        } catch(err) {
            error = err;
        }

        expect(error.message).to.equal(`Could not retrieve hash attribute for schema: ${DELETE_OBJ_TEST.schema} table: ${DELETE_OBJ_TEST.table}`);
    });

    it('Test for nominal behaviour, delete records is called as expected ', () => {
        global.hdb_schema[DELETE_OBJ_TEST.schema][DELETE_OBJ_TEST.table].hash_attribute = 'id';
        let result = heDeleteRecordsBefore(DELETE_OBJ_TEST);
        let expected_delete_obj = {
            hash_values: ["8", "9", "100"],
            operation: "delete",
            schema: "animals",
            table: "horses"
        };

        expect(result).to.equal(DELETE_RECORDS_MSG);
        expect(he_delete_records_stub).to.have.been.calledWith(expected_delete_obj);
    });

    it('Test that delete records is not called if no records found', () => {
        hdb_helium_stub.returns([]);
        let result = heDeleteRecordsBefore(DELETE_OBJ_TEST);

        expect(result).to.equal(undefined);
    });

    it('Test that error from search by value range is caught', () => {
        let error_msg = 'Error searching for value';
        hdb_helium_stub.throws(new Error(error_msg));
        let error;

        try {
            heDeleteRecordsBefore(DELETE_OBJ_TEST);
        } catch(err) {
            error = err;
        }

        expect(error.message).to.equal(error_msg);
    });
});
