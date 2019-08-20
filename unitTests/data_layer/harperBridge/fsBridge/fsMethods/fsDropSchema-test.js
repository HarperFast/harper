'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
let fsDropSchema = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDropSchema');
const log = require('../../../../../utility/logging/harper_logger');
const terms = require('../../../../../utility/hdbTerms');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const DROP_SCHEMA_OBJ_TEST = {
    operation: "drop_schema",
    schema: "dropTest",
};
const TABLES_TEST = [{id: '123d24'}];

describe('Tests for file system module fsDropSchema', () => {
    let sandbox = sinon.createSandbox();
    let fs_delete_records_stub = sandbox.stub();

    before(() => {
        fsDropSchema.__set__('fsDeleteRecords', fs_delete_records_stub);
    });

    after(() => {
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDropSchema');
    });

    context('Tests for dropSchema function', () => {
        let p_search_by_value_stub;
        let move_schema_to_trash_stub;
        let move_schema_to_trash_rw;
        let delete_attr_struc_stub;
        let log_error_spy;
        let schema = DROP_SCHEMA_OBJ_TEST.schema;
        let delete_schema_obj = {
            table: terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
            schema: terms.SYSTEM_SCHEMA_NAME,
            hash_values: [schema]
        };
        let search_obj = {
            schema: terms.SYSTEM_SCHEMA_NAME,
            table: terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
            hash_attribute: terms.SYSTEM_TABLE_HASH,
            search_attribute: terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_KEY,
            search_value: schema,
            get_attributes: ['id']
        };
        let search_results_tests = [{id: "12d34"}];
        
        before(() => {
            p_search_by_value_stub = sandbox.stub().resolves(search_results_tests);
            move_schema_to_trash_stub = sandbox.stub();
            delete_attr_struc_stub = sandbox.stub();
            fsDropSchema.__set__('p_search_by_value', p_search_by_value_stub);
            move_schema_to_trash_rw = fsDropSchema.__set__('moveSchemaToTrash', move_schema_to_trash_stub);
            fsDropSchema.__set__('deleteAttrStructure', delete_attr_struc_stub);
            log_error_spy = sandbox.spy(log, 'error');
        });

        after(function () {
            sandbox.restore();
            move_schema_to_trash_rw();
        });

        it('Test function executes correctly and all stubs are called as expected', async () => {
            await fsDropSchema(DROP_SCHEMA_OBJ_TEST);

            expect(fs_delete_records_stub).to.have.been.calledWith(delete_schema_obj);
            expect(p_search_by_value_stub).to.have.been.calledWith(search_obj);
            expect(move_schema_to_trash_stub).to.have.been.calledWith(DROP_SCHEMA_OBJ_TEST, search_results_tests);
            expect(delete_attr_struc_stub).to.have.been.calledWith(DROP_SCHEMA_OBJ_TEST);
        });

        it('Error from search is caught and logged', async () => {
            p_search_by_value_stub.throws(new Error('Error searching for records'));
            let test_err_result = await test_utils.testError(fsDropSchema(DROP_SCHEMA_OBJ_TEST), 'Error searching for records');

            expect(test_err_result).to.be.true;
            expect(log_error_spy).to.have.been.called;
        });
    });

    context('Tests for moveSchemaToTrash function', () => {
        let move_schema_to_trash;
        let move_folder_to_trash_stub;
        let delete_table_obj_test = {
            table: terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
            schema: terms.SYSTEM_SCHEMA_NAME,
            hash_values: [
                TABLES_TEST[0].id
            ]
        };

        before(() => {
            move_schema_to_trash = fsDropSchema.__get__('moveSchemaToTrash');
            move_folder_to_trash_stub = sandbox.stub();
            fsDropSchema.__set__('moveFolderToTrash', move_folder_to_trash_stub);
        });

        it('Test that tables parameter was null error is caught and thrown', async () => {
            let test_err_result = await test_utils.testError(move_schema_to_trash(DROP_SCHEMA_OBJ_TEST, null), 'tables parameter was null.');

            expect(test_err_result).to.be.true;
        });

        it('Test move folder to trash and delete records stubs are called as expected', async () => {
            await move_schema_to_trash(DROP_SCHEMA_OBJ_TEST, TABLES_TEST);

            expect(move_folder_to_trash_stub).to.have.been.called;
            expect(fs_delete_records_stub).to.have.been.calledWith(delete_table_obj_test);
        });

        it('Test that an error from delete records is caught and thrown', async () => {
            fs_delete_records_stub.throws(new Error('Error deleting record'));
            let test_err_result = await test_utils.testError(move_schema_to_trash(DROP_SCHEMA_OBJ_TEST, TABLES_TEST), 'Error deleting record');

            expect(test_err_result).to.be.true;
        });
    });
});
