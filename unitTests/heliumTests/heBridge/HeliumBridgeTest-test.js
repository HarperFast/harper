'use strict';

const test_utils = require('../../test_utils');
test_utils.preTestPrep();
test_utils.buildHeliumTestVolume();

const rewire = require('rewire');
let HeliumBridge = rewire('../../../../data_layer/harperBridge/heBridge/HeliumBridge');
const log = require('../../../utility/logging/harper_logger');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const INSERT_OBJ_TEST = {
    operation: "insert",
    schema: "system",
    table: "hdb_schema",
    records: [
        {
            name: "cat",
            createddate: "1565108103810"
        }
    ]
};

const RESULT_TEST = {
    written_hashes: [
        "cat"
    ],
    skipped_hashes: []
};

const ATTRIBUTES_TEST = [
    "name",
    "createddate"
];

const SCHEMA_TABLE_TEST = {
    hash_attribute: "name",
    name: "hdb_schema",
    schema: "system",
    residence: [
        "*"
    ],
    attributes: [
        {
            attribute: "name"
        },
        {
            attribute: "createddate"
        }
    ]
};

let DELETE_OBJ_TEST = {
    operation: "delete",
    table: "doggo",
    schema: "deleteTest",
    hash_values: [ 8 ]
};

describe('Tests for the Helium bridge class', () => {
    let sandbox = sinon.createSandbox();
    let heBridge = new HeliumBridge();
    let log_error_spy;

    before(() => {
        log_error_spy = sandbox.spy(log, 'error');
    });

    after(() => {
        sandbox.restore();
        rewire('../../../../data_layer/harperBridge/heBridge/HeliumBridge');
        test_utils.teardownHeliumTestVolume(global.hdb_helium);
    });

    context('Test heCreateRecords method', () => {
        let he_create_records_stub = sandbox.stub();
        let he_create_records_rw;

        before(() => {
            he_create_records_rw = HeliumBridge.__set__('heCreateRecords', he_create_records_stub);
        });

        after(() => {
            sandbox.restore();
            he_create_records_rw();
        });

        it('Test heCreateRecords method is called and result is as expected', async () => {
            he_create_records_stub.resolves(RESULT_TEST);
            let result = await heBridge.createRecords(INSERT_OBJ_TEST);

            expect(result).to.equal(RESULT_TEST);
            expect(he_create_records_stub).to.have.been.calledWith(INSERT_OBJ_TEST);
        });

        it('Test that error is caught, thrown and logged', async () => {
            let error_msg = 'Error creating records in Helium';
            he_create_records_stub.throws(new Error(error_msg));
            let test_error_result = await test_utils.testError(heBridge.createRecords(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST), error_msg);

            expect(test_error_result).to.be.true;
            expect(log_error_spy).to.have.been.calledOnce;
        });
    });

    context('Test heDeleteRecords method', () => {
        let he_delete_records_stub = sandbox.stub();
        let he_delete_records_rw;

        before(() => {
            he_delete_records_rw = HeliumBridge.__set__('heDeleteRecords', he_delete_records_stub);
        });

        after(() => {
            sandbox.restore();
            he_delete_records_rw();
        });

        it('Test heDeleteRecords method is called and result is as expected', async () => {
            let expected_result = {
                message: '1 record successfully deleted',
                deleted_hashes: [ '8' ],
                skipped_hashes: []
            };
            he_delete_records_stub.resolves(expected_result);
            let result = await heBridge.deleteRecords(DELETE_OBJ_TEST);

            expect(result).to.equal(expected_result);
            expect(he_delete_records_stub).to.have.been.calledWith(DELETE_OBJ_TEST);
        });

        it('Test that error is caught, thrown and logged', async () => {
            let error_msg = 'Error deleting records in Helium';
            he_delete_records_stub.throws(new Error(error_msg));
            let test_error_result = await test_utils.testError(heBridge.deleteRecords(DELETE_OBJ_TEST), error_msg);

            expect(test_error_result).to.be.true;
            expect(log_error_spy).to.have.been.calledOnce;
        });
    });
});