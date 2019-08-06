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
    ]};

const SCHEMA_OBJ_TEST = {
    operation: "create_schema",
    schema: "dev",
    };

describe('Tests for the file system bridge class', () => {
    let sandbox = sinon.createSandbox();
    let fs_bridge = new FileSystemBridge();
    let file_system_bridge_rw;
    let log_error_spy;

    before(() => {
        log_error_spy = sandbox.spy(log, 'error');
    });

    after(() => {
        FileSystemBridge = rewire('../../../../data_layer/harperBridge/fsBridge/FileSystemBridge');
    });

    context('Test createRecords method', () => {
        let fs_create_records_stub = sandbox.stub();

        before(() => {
            file_system_bridge_rw = FileSystemBridge.__set__('fs_create_records', fs_create_records_stub);
        });

        after(() => {
            sandbox.restore();
        });

        it('Test createRecords method is called and result is as expected', async () => {
            fs_create_records_stub.resolves(RESULT_TEST);
            let result = await fs_bridge.createRecords(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST);

            expect(result).to.equal(RESULT_TEST);
            expect(fs_create_records_stub).to.have.been.calledWith(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST);
        });

        it('Test that error is caught, thrown and logged', async () => {
            fs_create_records_stub.throws(new Error('Error creating records'));
            await test_utils.testForError(fs_bridge.createRecords(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST), 'Error creating records');

            expect(log_error_spy).to.have.been.calledOnce;
        });
    });

    context('Test createSchema method', () => {
        let fs_create_schema_stub = sandbox.stub();

        before(() => {
            file_system_bridge_rw = FileSystemBridge.__set__('fs_create_schema', fs_create_schema_stub);
        });

        after(() => {
            sandbox.restore();
        });

        it('Test createSchema method is called and result is as expected', async () => {
            await fs_bridge.createSchema(SCHEMA_OBJ_TEST);

            expect(fs_create_schema_stub).to.have.been.calledWith(SCHEMA_OBJ_TEST);
        });

        it('Test that error is caught, thrown and logged', async () => {
            fs_create_schema_stub.throws(new Error('Error creating schema'));
            await test_utils.testForError(fs_bridge.createSchema(SCHEMA_OBJ_TEST), 'Error creating schema');

            expect(log_error_spy).to.have.been.calledOnce;
        });

    });
});
