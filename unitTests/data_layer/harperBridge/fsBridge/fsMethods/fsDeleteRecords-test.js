'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
let fs_delete_records = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDeleteRecords');
const log = require('../../../../../utility/logging/harper_logger');
const fs = require('graceful-fs');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

let DELETE_OBJ_TEST = {
    operation: "delete",
    table: "doggo",
    schema: "deleteTest",
    hash_values: [
        8,
        9
    ],
    records: [
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
    ]
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

const HASH_ATTRIBUTE = 'id';
const TABLE_TEST = 'doggo';
const SCHEMA_TEST = 'deleteTest';
const FS_DIR_TEST = test_utils.getMockFSPath();

describe('Tests for file system module fsDeleteRecords', () => {
    let sandbox = sinon.createSandbox();
    let log_error_stub;

    before(() => {
        fs_delete_records.__set__('BASE_PATH', FS_DIR_TEST);
        log_error_stub = sandbox.stub(log, 'error');
    });

    after(() => {
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDeleteRecords');
        test_utils.tearDownMockFS();
    });

    it('Test item not found msg is returned if delete object records empty', async () => {
        let delete_obj_test_clone = test_utils.deepClone(DELETE_OBJ_TEST);
        delete_obj_test_clone.records = [];
        let test_err_result = await test_utils.testError(fs_delete_records(delete_obj_test_clone), 'Item not found');

        expect(test_err_result).to.be.true;
    });
    
    it('Test that the check for hash attribute returns a not found message', async () => {
        let test_err_result = await test_utils.testError(fs_delete_records(DELETE_OBJ_TEST), 'hash attribute not found');

        expect(test_err_result).to.be.true;
    });

    // This test utilizes a mock file system that is temporally created in the unit test folder. The FS is created and then
    // deleted from. We test that all the files have been deleted. After testing the mock FS is torn down.
    it('Test mock file system is successfully deleted', async () => {
        let mock_fs = test_utils.createMockFS(HASH_ATTRIBUTE, SCHEMA_TEST, TABLE_TEST, TEST_DATA_DOG);
        let files_to_check = [...mock_fs[0].paths.files, ...mock_fs[1].paths.files];

        global.hdb_schema = {
            [DELETE_OBJ_TEST.schema]: {
                [DELETE_OBJ_TEST.table]: {
                    name: DELETE_OBJ_TEST.table,
                    hash_attribute: 'id'
                }
            }
        };

        await fs_delete_records(DELETE_OBJ_TEST);
        for (let i = 0; i < files_to_check.length; i++) {
            expect(fs.existsSync(files_to_check[i])).to.be.false;
        }
    });

    // This test assumes the global schema has been set in previous test.
    it('Test that an error fom unlink is caught and logged', async () => {
        let unlink_stub = sandbox.stub().throws(new Error('path does not exist'));
        fs_delete_records.__set__('unlink', unlink_stub);
        let test_err_result = await test_utils.testError(fs_delete_records(DELETE_OBJ_TEST), 'path does not exist');

        expect(test_err_result).to.be.true;
        expect(log_error_stub).has.been.called;
    });
});
