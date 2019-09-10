'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);
const rewire = require('rewire');
const processData = rewire('../../../../../data_layer/harperBridge/fsBridge/fsUtility/processData');
const hdb_terms = require('../../../../../utility/hdbTerms');

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

describe('Tests for processData fsUtility module', () => {
    let sandbox = sinon.createSandbox();
    let create_folders_rw;
    let write_raw_data_rw;

    context('Test processData function', () => {
        let create_folders_stub = sandbox.stub();
        let write_raw_data_stub = sandbox.stub();

        before(() => {
            create_folders_rw = processData.__set__('createFolders', create_folders_stub);
            write_raw_data_rw = processData.__set__('writeRawDataFiles', write_raw_data_stub);
        });

        after(() => {
            create_folders_rw();
            write_raw_data_rw();
            sandbox.restore();
        });

        it('Test processData calls createFolders and writeRawDataFiles as expected', async () => {
            await processData(DATA_WRAPPER_TEST);

            expect(create_folders_stub).to.have.been.calledWith(DATA_WRAPPER_TEST.folders);
            expect(write_raw_data_stub).to.have.been.calledWith(DATA_WRAPPER_TEST.raw_data);
        });

        it('Test error is caught and thrown', async () => {
            create_folders_stub.throws(new Error('Error creating folder'));
            let test_error_response = await test_utils.testError(processData(DATA_WRAPPER_TEST), 'Error creating folder');

            expect(test_error_response).to.be.true;
        });
    });

    context('Test createFolders function', () => {
        let mkdirp_stub = sandbox.stub();
        let mkdirp_create_record_rw;

        before(() => {
            create_folders_rw = processData.__get__('createFolders');
            mkdirp_create_record_rw = processData.__set__('mkdirp', mkdirp_stub);
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
            write_raw_data_rw = processData.__get__('writeRawDataFiles');
            write_file_rw = processData.__set__('writeFile', write_raw_data_stub);
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
