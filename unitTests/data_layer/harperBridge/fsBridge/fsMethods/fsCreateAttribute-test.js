'use strict';
const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
let fsCreateAttribute = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateAttribute');
const log = require('../../../../../utility/logging/harper_logger');
const hdb_terms = require('../../../../../utility/hdbTerms');
const env = require('../../../../../utility/environment/environmentManager');
const fs = require('fs-extra');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const HDB_PATH = `${env.getHdbBasePath()}/schema/`;
const FS_DIR_TEST = test_utils.getMockFSPath();
const HASH_ATTR_TEST = 'id';
const CREATE_ATTR_OBJ_TEST = {
    operation: "create_attribute",
    schema: "attrUnitTest",
    table: "dog",
    attribute: "another_attribute",
};
const TEST_DATA_DOG = [
    {
        age: 5,
        breed: "Mutt",
        id: 8,
        name: "Harper"
    },
    {
        age: 5,
        breed: "Mutt",
        id: 9,
        name: "Penny"
    }
];
const SCHEMA_TABLE_TEST = {
    hash_attribute: "id",
    name: "hdb_attribute",
    schema: "system",
    residence: [
        "*"
    ],
    attributes: [
        {
            attribute: "id"
        },
        {
            attribute: "schema"
        }
    ]
};
const INSERT_OBJ_TEST = {
    operation: "insert",
    schema: "system",
    table: "hdb_attribute",
    hash_attribute: "id",
    records: [
        {
            "schema": "attrUnitTest",
            "table": "dog",
            "attribute": "another_attributee",
            "id": "cb765467-ec0f-4e1e-a467-9c7e984e3059",
            "schema_table": "attrUnitTest.dog"
        }
    ]
};
const ATTRIBUTES_TEST = [
    "schema",
    "table",
    "attribute",
    "id",
    "schema_table"
];
const WRITTEN_HASH_TEST = ["7d0181"];
const SKIPPED_HASH_TEST = ["13md39"];
const DATA_WRAPPER_TEST = {
    folders: [
        "/system/hdb_attribute/schema/attrUnitTest",
        "/system/hdb_attribute/table/dog",
    ],
    raw_data: [
        {
            "path": "/system/hdb_attribute/__hdb_hash/schema/7d018143-fe0a-47c9-8f44-2fa6eecb46a0.hdb",
            "value": "attrUnitTest",
            "link_path": "/system/hdb_attribute/schema/attrUnitTest/7d018143-fe0a-47c9-8f44-2fa6eecb46a0.hdb"
        }
    ],
    skipped: SKIPPED_HASH_TEST,
    unlinks: WRITTEN_HASH_TEST
};
const EXISTING_ROWS_TEST = {};

describe('Tests for file system module fsCreateAttribute', () => {
    let sandbox = sinon.createSandbox();

    after(() => {
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateAttribute');
        test_utils.tearDownMockFS();
    });

    afterEach(() => {
        sandbox.restore();
    });

    context('Tests for createAttribute function', () => {
        let mock_fs;

        before(() => {
            mock_fs = test_utils.createMockFS(HASH_ATTR_TEST, CREATE_ATTR_OBJ_TEST.schema, CREATE_ATTR_OBJ_TEST.table, TEST_DATA_DOG);
            fsCreateAttribute.__set__('HDB_PATH', FS_DIR_TEST);
        });

        it('Test that validation catches and throws from invalid object', async () => {
            let test_err_result = await test_utils.testError(fsCreateAttribute({schema: "TestSchema", table: "TestTable"}), 'Attribute  is required');

            expect(test_err_result).to.be.true;
        });

        it('Test new attribute is added to system schema on file system as expected', async () => {
            await fsCreateAttribute(CREATE_ATTR_OBJ_TEST);
            let test_dir_path = `${FS_DIR_TEST}/system/hdb_attribute/attribute/${CREATE_ATTR_OBJ_TEST.attribute}`;
            let exists = await fs.pathExists(test_dir_path);

            expect(exists).to.be.true;
        });

        it('Test that an error is thrown if the attribute already exists', async () => {
            let search_result_fake = [{schema: CREATE_ATTR_OBJ_TEST.schema, table: CREATE_ATTR_OBJ_TEST.table}];
            let p_search_value_stub = sandbox.stub().resolves(search_result_fake);
            fsCreateAttribute.__set__('p_search_search_by_value', p_search_value_stub);
            let test_err_result = await test_utils.testError(fsCreateAttribute(CREATE_ATTR_OBJ_TEST),
                `attribute already exists with id {"schema":"${CREATE_ATTR_OBJ_TEST.schema}","table":"${CREATE_ATTR_OBJ_TEST.table}"}`);

            expect(test_err_result).to.be.true;
        });
    });

    context('Tests for insertData function', () => {
        let insert_data = fsCreateAttribute.__get__('insertData');
        let insert_update_val_rw;
        let process_rows_rw;
        let process_data_rw;
        let convert_op_rw;
        let validate_fake = {
            schema_table: SCHEMA_TABLE_TEST,
            hashes: WRITTEN_HASH_TEST,
            attributes: SKIPPED_HASH_TEST,
        };
        let process_rows_fake = {
            written_hashes: WRITTEN_HASH_TEST,
            skipped_hashes: SKIPPED_HASH_TEST
        };
        let insert_update_val_stub = sandbox.stub().resolves(validate_fake);
        let process_rows_stub = sandbox.stub().resolves(process_rows_fake);
        let process_data_stub = sandbox.stub();
        let convert_op_stub = sandbox.stub();

        before(() => {
            insert_update_val_rw = fsCreateAttribute.__set__('insertUpdateValidate', insert_update_val_stub);
            process_rows_rw = fsCreateAttribute.__set__('processRows', process_rows_stub);
            process_data_rw = fsCreateAttribute.__set__('processData', process_data_stub);
            convert_op_rw = fsCreateAttribute.__set__('convertOperationToTransaction', convert_op_stub);
        });

        after(() => {
            insert_update_val_rw();
            process_rows_rw();
            process_data_rw();
            convert_op_rw();
        });

        it('Test all stubs are called as expected and valid object is returned', async () => {
            let return_obj = {
                message: 'inserted 1 of 1 records',
                skipped_hashes: [ '13md39' ],
                inserted_hashes: [ '7d0181' ]
            };
            let result = await insert_data(INSERT_OBJ_TEST);

            expect(result).to.eql(return_obj);
            expect(insert_update_val_stub).to.have.been.calledWith(INSERT_OBJ_TEST);
            expect(process_rows_stub).to.have.been.calledWith(INSERT_OBJ_TEST, SKIPPED_HASH_TEST, SCHEMA_TABLE_TEST, null);
            expect(process_data_stub).to.have.been.calledWith();
        });

        it('Test that exception from validate is caught', async () => {
            let error_msg = 'validation error';
            insert_update_val_stub.throws(new Error(error_msg));
            let test_err_result = await test_utils.testError(insert_data(INSERT_OBJ_TEST), error_msg);

            expect(test_err_result).to.be.true;
        });

        context('Tests for processRows function', () => {
            let process_rows = fsCreateAttribute.__get__('processRows');
            let exploder_obj_fake = {schema: 'test'};
            let write_process_obj_stub = sandbox.stub().returns(exploder_obj_fake);
            let write_process_obj_rw;
            let data_write_process_stub = sandbox.stub().resolves(DATA_WRAPPER_TEST);
            let data_write_process_rw;
            
            before(() => {
                write_process_obj_rw = fsCreateAttribute.__set__('WriteProcessorObject', write_process_obj_stub);
                data_write_process_rw = fsCreateAttribute.__set__('dataWriteProcessor', data_write_process_stub);
            });

            after(() => {
                write_process_obj_rw();
                data_write_process_rw();
            });

            it('Test write processor and data write stubs are called and returned as expected', async () => {
                let result = await process_rows(INSERT_OBJ_TEST, ATTRIBUTES_TEST, SCHEMA_TABLE_TEST, EXISTING_ROWS_TEST);

                expect(result).to.equal(DATA_WRAPPER_TEST);
                expect(write_process_obj_stub).to.have.been.called;
                expect(data_write_process_stub).to.have.been.calledWith(exploder_obj_fake);
            });
        });

        context('Test for processData function', () => {
            let process_data = fsCreateAttribute.__get__('processData');
            let create_folders_stub = sandbox.stub();
            let create_folders_rw;
            let write_raw_data_stub = sandbox.stub();
            let write_raw_data_rw;

            before(() => {
                create_folders_rw = fsCreateAttribute.__set__('createFolders', create_folders_stub);
                write_raw_data_rw = fsCreateAttribute.__set__('writeRawDataFiles', write_raw_data_stub)
            });

            after(() => {
                write_raw_data_rw();
                create_folders_rw();
            });

            it('Test that createFolders and writeRawDataFiles stubs are called', async () => {
                await process_data(DATA_WRAPPER_TEST);

                expect(create_folders_stub).to.have.been.calledWith(DATA_WRAPPER_TEST.folders);
                expect(write_raw_data_stub).to.have.been.calledWith(DATA_WRAPPER_TEST.raw_data);
            });

            it('Test error from create folders is caught and thrown', async () => {
                let error_msg = 'Error creating a thing for another thing';
                create_folders_stub.throws(new Error(error_msg));
                let test_err_result = await test_utils.testError(process_data(DATA_WRAPPER_TEST), error_msg);

                expect(test_err_result).to.be.true;
            });
        });

        context('Test createFolders function', () => {
            let create_folders = fsCreateAttribute.__get__('createFolders');

            it('Test that a folder is created on the file system', async () => {
                let test_folders_array = [`${FS_DIR_TEST}/im_a_test_folder`];
                await create_folders(test_folders_array);
                let exists = await fs.pathExists(test_folders_array[0]);

                expect(exists).to.be.true;
            });

            it('Test that an error from mkdirp is caught and thrown', async () => {
                let wrong_folders = `${FS_DIR_TEST}/im_a_test_folder`;
                let test_err_result = await test_utils.testError(create_folders(wrong_folders), 'folders.map is not a function');

                expect(test_err_result).to.be.true;
            });
        });

        context('Test writeRawDataFile function', () => {
            let write_raw_data_file = fsCreateAttribute.__get__('writeRawDataFiles');

            it('Test that a file is written to the file system', async () => {
                let test_file_array = [
                    {
                        path: `${FS_DIR_TEST}/testWriteFile/123456.hdb`,
                        value: "attrUnitTest",
                        link_path: `${FS_DIR_TEST}/testWriteFile/linkFile.hdb`,
                    }
                ];
                await write_raw_data_file(test_file_array);
                let exists_path = await fs.pathExists(test_file_array[0].path);
                let exists_link = await fs.pathExists(test_file_array[0].link_path);

                expect(exists_path).to.be.true;
                expect(exists_link).to.be.true;
            });

        });
    });
});
