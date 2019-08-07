'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
let fs_create_records = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateRecords');
const hdb_core_insert = require('../../../../../data_layer/insert');
const log = require('../../../../../utility/logging/harper_logger');
const hdb_terms = require('../../../../../utility/hdbTerms');
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
            name: "dev",
            createddate: 1565028087315
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

const DATA_WRAPPER_TEST = {
    written_hashes: [
        "dev"
    ],
    folders: [
        "/Users/david/hdb/schema/system/hdb_schema/name/dev",
    ],
    raw_data: [
        {
            path: "/Users/david/hdb/schema/system/hdb_schema/__hdb_hash/name/dev.hdb",
            value: "dev"
        },
    ],
    skipped: [],
    unlinks: []
    };

const FOLDERS_TEST = [
    "/Users/david/hdb/schema/dev/dog/__hdb_hash/name",
    "/Users/david/hdb/schema/dev/dog/__hdb_hash/breed",
];

const WRITE_FILES_DATA_TEST = [
    {
        path: "/Users/davidcockerill/hdb/schema//dev/dog/__hdb_hash/name/12.hdb",
        value: "Harper",
        link_path: "/Users/davidcockerill/hdb/schema//dev/dog/name/Harper/12.hdb"
    }];

describe('Tests for file system module fsCreateRecords', () => {
    let sandbox = sinon.createSandbox();
    let process_rows_rw;
    let process_data_rw;
    let create_folders_rw;
    let write_raw_data_rw;
    let log_error_spy;

    before(() => {
        log_error_spy = sandbox.spy(log, 'error');
    });

    after(() => {
        sandbox.restore();
        fs_create_records = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateRecords');
    });

    context('Test createRecords function', () => {
        let process_rows_stub = sandbox.stub();
        let insert_check_new_attr_stub;
        let process_data_stub = sandbox.stub();

        before(() => {
            process_rows_rw = fs_create_records.__set__('processRows', process_rows_stub);
            insert_check_new_attr_stub = sandbox.stub(hdb_core_insert, 'checkForNewAttributes');
            process_data_rw = fs_create_records.__set__('processData', process_data_stub);
        });
        
        after(() => {
            sandbox.restore();
            process_rows_rw();
            process_data_rw();
        });
        
        it('Test createRecords calls processRows, checkAttr, processData as expected', async () => {
            process_rows_stub.resolves(DATA_WRAPPER_TEST);
            let expected_result = {
                "written_hashes": [
                    "dev"
                ],
                "skipped_hashes": []
                };

            let result = await fs_create_records(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST);

            expect(result).to.eql(expected_result);
            expect(insert_check_new_attr_stub).to.have.been.calledWith(INSERT_OBJ_TEST.hdb_auth_header, SCHEMA_TABLE_TEST, ATTRIBUTES_TEST);
            expect(process_data_stub).to.have.been.calledWith(DATA_WRAPPER_TEST);
        });

        it('Test error is caught and thrown', async () => {
            insert_check_new_attr_stub.throws(new Error('Insert error'));
            let test_error_response = await test_utils.testError(fs_create_records(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST), 'Insert error');

            expect(test_error_response).to.be.true;
            expect(log_error_spy).to.have.been.calledOnce;
        });
    });

    context('Test processRows function', () => {
        let data_write_processor_stub = sandbox.stub().resolves(DATA_WRAPPER_TEST);
        let data_write_processor_rw;
        let existing_rows = undefined;
        
        before(() => {
            data_write_processor_rw = fs_create_records.__set__('dataWriteProcessor', data_write_processor_stub);
            process_rows_rw = fs_create_records.__get__('processRows');
        });
        
        after(() => {
            sandbox.restore();
            data_write_processor_rw();
        });
        
        it('Test processRows calls WriteProcessorObject and dataWriteProcessor as expected', async () => {
            let result = await process_rows_rw(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST, existing_rows);

            expect(result).to.eql(DATA_WRAPPER_TEST);
            expect(data_write_processor_stub).to.have.been.calledOnce;
        });

        it('Test error is caught and thrown', async () => {
            data_write_processor_stub.throws(new Error('Data write error'));
            let test_error_response = await test_utils.testError(process_rows_rw(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST, existing_rows), 'Data write error');

            expect(test_error_response).to.be.true;
        });
    });

    context('Test processData function', () => {
        let create_folders_stub = sandbox.stub();
        let write_raw_data_stub = sandbox.stub();

        before(() => {
            create_folders_rw = fs_create_records.__set__('createFolders', create_folders_stub);
            write_raw_data_rw = fs_create_records.__set__('writeRawDataFiles', write_raw_data_stub);
            process_data_rw = fs_create_records.__get__('processData');
        });

        after(() => {
            create_folders_rw();
            write_raw_data_rw();
            sandbox.restore();
        });

        it('Test processData calls createFolders and writeRawDataFiles as expected', async () => {
            await process_data_rw(DATA_WRAPPER_TEST);

            expect(create_folders_stub).to.have.been.calledWith(DATA_WRAPPER_TEST.folders);
            expect(write_raw_data_stub).to.have.been.calledWith(DATA_WRAPPER_TEST.raw_data);
        });

        it('Test error is caught and thrown', async () => {
            create_folders_stub.throws(new Error('Error creating folder'));
            let test_error_response = await test_utils.testError(process_data_rw(DATA_WRAPPER_TEST), 'Error creating folder');

            expect(test_error_response).to.be.true;
        });
    });

    context('Test createFolders function', () => {
        let mkdirp_stub = sandbox.stub();
        let mkdirp_create_record_rw;

        before(() => {
            create_folders_rw = fs_create_records.__get__('createFolders');
            mkdirp_create_record_rw = fs_create_records.__set__('mkdirp', mkdirp_stub);
        });

        after(() => {
            create_folders_rw();
            mkdirp_create_record_rw();
            sandbox.restore();
        });

        it('Test createFolders calls mkdirp as expected', async () => {
            await create_folders_rw(FOLDERS_TEST);

            expect(mkdirp_stub).to.have.been.calledWith(FOLDERS_TEST, {mode:  hdb_terms.HDB_FILE_PERMISSIONS});
        });
    });

    context('Test writeRawDataFiles function', () => {
        let write_raw_data_stub = sandbox.stub();
        let write_raw_data_rw;
        let write_file_rw;

        before(() => {
            write_raw_data_rw = fs_create_records.__get__('writeRawDataFiles');
            write_file_rw = fs_create_records.__set__('writeFile', write_raw_data_stub);
        });

        after(() => {
           sandbox.restore();
           write_file_rw();
        });

        it('Test writeRawDataFiles calls write_file as expected', async () => {
            await write_raw_data_rw(WRITE_FILES_DATA_TEST);

            expect(write_raw_data_stub).to.have.calledWith(WRITE_FILES_DATA_TEST);
        });

        it('Test error is caught and thrown', async () => {
            write_raw_data_stub.throws(new Error('Error writing raw date'));
            let test_error_result = await test_utils.testError(write_raw_data_rw(WRITE_FILES_DATA_TEST), 'Error writing raw date');

            expect(test_error_result).to.be.true;

        });
    });
});
