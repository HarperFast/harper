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
    ]
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

const SCHEMA_OBJ_TEST = {
    operation: "create_schema",
    schema: "dev",
};

const DELETE_OBJ_TEST = {
    operation: "delete",
    table: "dog",
    schema: "dev",
    hash_values: [
        8,
    ]
};

const CREATE_TABLE_OBJ_TEST = {
    operation: 'create_table',
    schema: 'dogsrule',
    table: 'catsdrool',
    hash_attribute: 'id',
    };

const TABLE_SYSTEM_DATA_TEST = {
    name: CREATE_TABLE_OBJ_TEST.table,
    schema: CREATE_TABLE_OBJ_TEST.schema,
    hash_attribute: CREATE_TABLE_OBJ_TEST.hash_attribute
    };

describe('Tests for the file system bridge class', () => {
    let sandbox = sinon.createSandbox();
    let fsBridge = new FileSystemBridge();
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
            fs_create_records_rw();
        });

        it('Test createRecords method is called and result is as expected', async () => {
            fs_create_records_stub.resolves(RESULT_TEST);
            let result = await fsBridge.createRecords(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST);

            expect(result).to.equal(RESULT_TEST);
            expect(fs_create_records_stub).to.have.been.calledWith(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST);
        });

        it('Test that error is caught, thrown and logged', async () => {
            fs_create_records_stub.throws(new Error('Error creating records'));
            let test_error_result = await test_utils.testError(fsBridge.createRecords(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST), 'Error creating records');

            expect(test_error_result).to.be.true;
            expect(log_error_spy).to.have.been.calledOnce;
        });
    });

    context('Test createSchema method', () => {
        let fs_create_schema_stub = sandbox.stub();
        let fs_create_schema_rw;

        before(() => {
            fs_create_schema_rw = FileSystemBridge.__set__('fsCreateSchema', fs_create_schema_stub);
        });

        after(() => {
            sandbox.restore();
            fs_create_schema_rw();
        });

        it('Test createSchema method is called and result is as expected', async () => {
            await fsBridge.createSchema(SCHEMA_OBJ_TEST);

            expect(fs_create_schema_stub).to.have.been.calledWith(SCHEMA_OBJ_TEST);
        });

        it('Test that error is caught, thrown and logged', async () => {
            fs_create_schema_stub.throws(new Error('Error creating schema'));
            let test_error_result = await test_utils.testError(fsBridge.createSchema(SCHEMA_OBJ_TEST), 'Error creating schema');

            expect(test_error_result).to.be.true;
            expect(log_error_spy).to.have.been.calledOnce;
        });

        context('Test createTable method', () => {
            let fs_create_table_stub = sandbox.stub();
            let fs_create_table_rw;

            before(() => {
                fs_create_table_rw = FileSystemBridge.__set__('fsCreateTable', fs_create_table_stub);
            });

            after(() => {
                sandbox.restore();
                fs_create_table_rw();
            });

            it('Test createTable method is called as expected', async () => {
                await fsBridge.createTable(TABLE_SYSTEM_DATA_TEST, CREATE_TABLE_OBJ_TEST);

                expect(fs_create_table_stub).to.have.been.calledWith(TABLE_SYSTEM_DATA_TEST, CREATE_TABLE_OBJ_TEST);
            });

            it('Test that error is caught, thrown and logged', async () => {
                fs_create_table_stub.throws(new Error('Error creating table'));
                let test_error_result = await test_utils.testError(fsBridge.createTable(TABLE_SYSTEM_DATA_TEST, CREATE_TABLE_OBJ_TEST), 'Error creating table');

                expect(test_error_result).to.be.true;
                expect(log_error_spy).to.have.been.calledOnce;
            });
        });
    });

    context('Test deleteRecords method', () => {
        let fs_delete_records_stub = sandbox.stub();
        let fs_delete_records_rw;

        before(() => {
            fs_delete_records_rw = FileSystemBridge.__set__('fsDeleteRecords', fs_delete_records_stub);
        });

        after(() => {
            sandbox.restore();
            fs_delete_records_rw();
        });

        it('Test deleteRecords method is called and result is as expected', async () => {
            await fsBridge.deleteRecords(DELETE_OBJ_TEST);

            expect(fs_delete_records_stub).to.have.been.calledWith(DELETE_OBJ_TEST);
        });

        it('Test that error is caught, thrown and logged', async () => {
            fs_delete_records_stub.throws(new Error('Error deleting records'));
            let test_error_result = await test_utils.testError(fsBridge.deleteRecords(DELETE_OBJ_TEST), 'Error deleting records');

            expect(test_error_result).to.be.true;
            expect(log_error_spy).to.have.been.calledOnce;
        });
    });
});
