'use strict';

const test_utils = require('../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
let FileSystemBridge = rewire('../../../../data_layer/harperBridge/fsBridge/FileSystemBridge');
const log = require('../../../../utility/logging/harper_logger');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const RESULT_TEST = {
    written_hashes: [
        "dog"
    ],
    skipped_hashes: []
    };

const INSERT_OBJ_TEST = {
    operation: "insert",
    schema: "system",
    table: "hdb_schema",
    records: [
        {
            name: "dog",
            createddate: "1565108103810"
        }
    ]};

const ATTRIBUTES_TEST = [
    "name",
    "createddate"
    ];

const SCHEMA_TABLE = {
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
    ]};

describe('Tests for the file system bridge class', () => {
    let sandbox = sinon.createSandbox();
    let fs_bridge = new FileSystemBridge();
    let log_error_spy;

    before(() => {
        log_error_spy = sandbox.spy(log, 'error');
    });

    after(() => {
        sandbox.restore();
        FileSystemBridge = rewire('../../../../data_layer/harperBridge/fsBridge/FileSystemBridge');
    });

    context('Test createRecords method', () => {
        let fs_create_records_stub = sandbox.stub();
        let fs_create_records_rw;

        before(() => {
            fs_create_records_rw = FileSystemBridge.__set__('fsCreateRecords', fs_create_records_stub);
        });

        after(() => {
            sandbox.restore();
        });

        it('Test createRecords method is called and result is as expected', async () => {
            fs_create_records_stub.resolves(RESULT_TEST);
            let result = await fs_bridge.createRecords(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE);

            expect(result).to.equal(RESULT_TEST);
            expect(fs_create_records_stub).to.have.been.calledWith(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE);
        });

        it('Test that error is caught, thrown and logged', async () => {
            fs_create_records_stub.throws(new Error('Error creating records'));
            let test_error_result = await test_utils.testError(fs_bridge.createRecords(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE), 'Error creating records');

            expect(test_error_result).to.be.true;
            expect(log_error_spy).to.have.been.calledOnce;
        });
    });
});
