'use strict';

const test_utils = require('../../../../test_utils');
const rewire = require('rewire');
let fsDropTable = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDropTable');
const log = require('../../../../../utility/logging/harper_logger');
const env = require('../../../../../utility/environment/environmentManager');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const DROP_TABLE_OBJ_TEST = {
    operation: "drop_table",
    schema: "dev",
    table: "dog"
};

const SEARCH_RESULT_TEST = [
    {
        "name": "dog",
        "schema": "dev",
        "id": "12345"
    }
];

let delete_table_obj_expected = {
    table: "hdb_table",
    schema: "system",
    hash_attribute: "id",
    hash_values: [
        "12345"
    ]
};

describe('Tests for file system module fsDropTable', () => {
    let sandbox = sinon.createSandbox();

    after(() => {
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDropTable');
    });

    context('Test dropTable function', () => {
        let fs_search_by_hash_stub = sandbox.stub().resolves(SEARCH_RESULT_TEST);
        let fs_delete_records_stub = sandbox.stub();
        let move_table_to_trash_stub = sandbox.stub();
        let move_table_to_trash_rw;
        let delete_attr_structure_stub = sandbox.stub();
        let log_error_spy;

        before(() => {
            fsDropTable.__set__('fsSearchByValue', fs_search_by_hash_stub);
            fsDropTable.__set__('fsDeleteRecords', fs_delete_records_stub);
            move_table_to_trash_rw = fsDropTable.__set__('moveTableToTrash', move_table_to_trash_stub);
            fsDropTable.__set__('deleteAttrStructure', delete_attr_structure_stub);
            log_error_spy = sandbox.spy(log, 'error');
        });

        after(() => {
            move_table_to_trash_rw();
        });

        it('Test that mock filesystem has table dropped as expected ', async () => {
            let search_obj_expected = {
                schema: "system",
                table: "hdb_table",
                hash_attribute: "id",
                search_attribute: "name",
                search_value: "dog",
                get_attributes: [
                    "name",
                    "schema",
                    "id"
                ]
            };
            await fsDropTable(DROP_TABLE_OBJ_TEST);

            expect(fs_search_by_hash_stub).to.have.been.calledWith(search_obj_expected);
            expect(fs_delete_records_stub).to.have.been.calledWith(delete_table_obj_expected);
            expect(move_table_to_trash_stub).to.have.been.calledWith(DROP_TABLE_OBJ_TEST);
            expect(delete_attr_structure_stub).to.have.been.calledWith(DROP_TABLE_OBJ_TEST);
        });

        it('Test that error from search by value is caught and logged', async () => {
            let error_msg = 'Error searching for value';
            fs_search_by_hash_stub.throws(new Error(error_msg));
            let test_err_result = await test_utils.testError(fsDropTable(DROP_TABLE_OBJ_TEST), error_msg);

            expect(test_err_result).to.be.true;
            expect(log_error_spy).to.have.been.called;
        });
    });

    context('Test buildDropTableObject function', () => {
        let build_drop_table_object;

        before(() => {
            build_drop_table_object = fsDropTable.__get__('buildDropTableObject');
        });

        it('Test that correct error is thrown if delete table empty', () => {
            let error;
            try {
                build_drop_table_object(DROP_TABLE_OBJ_TEST, []);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceOf(Error);
            expect(error.message).to.equal(`${DROP_TABLE_OBJ_TEST.schema}.${DROP_TABLE_OBJ_TEST.table} was not found`);
        });

        it('Test that returned object is as expected', () => {
            let result = build_drop_table_object(DROP_TABLE_OBJ_TEST, SEARCH_RESULT_TEST);

            expect(result).to.eql(delete_table_obj_expected);
        });
    });

    context('Test moveFolderToTrash function', () => {
        let move_table_to_trash;
        let move_folder_to_trash_stub = sandbox.stub();

        before(() => {
            move_table_to_trash = fsDropTable.__get__('moveTableToTrash');
            fsDropTable.__set__('moveFolderToTrash', move_folder_to_trash_stub);
            sandbox.stub(env, 'get').returns('/users');
            fsDropTable.__set__('TRASH_BASE_PATH', '/root');
        });

        it('Test that move folder to trash is called', async () => {
            await move_table_to_trash(DROP_TABLE_OBJ_TEST);

            expect(move_folder_to_trash_stub).to.have.been.called;
        });

        it('Test that error from moveFolderToTrash is caught', async () => {
            let error_msg = 'Error moving folder to trash';
            move_folder_to_trash_stub.throws(new Error(error_msg));
            let test_err_result = await test_utils.testError(move_table_to_trash(DROP_TABLE_OBJ_TEST), error_msg);

            expect(test_err_result).to.be.true;
        });
    });
});
