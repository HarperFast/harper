'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
const fsDropAttribute = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDropAttribute');
const log = require('../../../../../utility/logging/harper_logger');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const DROP_ATTR_OBJ_TEST = {
    operation: "drop_attribute",
    schema: "dev",
    table: "dog",
    attribute: "another_attribute"
};
const ATTRIBUTES_TEST = [
    {id: 1},
    {name: 'Harper'}
];

describe('Tests for file system module fsDropAttribute', () => {
    let sandbox = sinon.createSandbox();

    after(() => {
        sandbox.restore();
    });

    context('Test dropAttribute function', () => {
        let log_error_spy;
        let drop_attr_from_system_stub = sandbox.stub();
        let move_folder_to_trash_stub = sandbox.stub();

        before(() => {
            log_error_spy = sandbox.spy(log, 'error');
            fsDropAttribute.__set__('dropAttributeFromSystem', drop_attr_from_system_stub);
        });

        it('Test that the first two ENOENT errors from moveFolderToTrash are logged but not thrown', async () => {
            try {
                await fsDropAttribute(DROP_ATTR_OBJ_TEST);
            } catch(err) {
                console.log(err);
            }

            expect(log_error_spy).to.have.been.called;
            expect(drop_attr_from_system_stub).to.have.been.called;
        });

        it('Test that moveFolderToTrash logs and throws error', async () => {
            let error_msg_fake = 'Error moving attribute path to trash';
            fsDropAttribute.__set__('moveFolderToTrash', move_folder_to_trash_stub);
            move_folder_to_trash_stub.throws(new Error(error_msg_fake));
            let test_err_result = await test_utils.testError(fsDropAttribute(DROP_ATTR_OBJ_TEST), error_msg_fake);

            expect(test_err_result).to.be.true;
        });

        it('Test for nominal behaviour and correct return result', async () => {
            let success_msg_fake = 'Successfully drop attribute';
            move_folder_to_trash_stub.resolves();
            drop_attr_from_system_stub.resolves(success_msg_fake);
            fsDropAttribute.__set__('moveFolderToTrash', move_folder_to_trash_stub);
            let result = await fsDropAttribute(DROP_ATTR_OBJ_TEST);

            expect(result).to.equal(success_msg_fake);
        });

        it('Test that error from dropAttributeFromSystem is logged and thrown', async () => {
            let error_msg = 'Error dropping attribute';
            drop_attr_from_system_stub.throws(new Error(error_msg));
            let test_err_result = await test_utils.testError(fsDropAttribute(DROP_ATTR_OBJ_TEST), error_msg);

            expect(test_err_result).to.be.true;
            expect(log_error_spy).to.have.been.calledWith(`There was a problem dropping attribute: ${DROP_ATTR_OBJ_TEST.attribute} from hdb_attribute.`);
        });
    });

    context('Test dropAttributeFromSystem function', () => {
        let fs_search_by_value_stub = sandbox.stub();
        let fs_delete_records_stub = sandbox.stub();
        let drop_attr_from_system = fsDropAttribute.__get__('dropAttributeFromSystem');

        before(() => {
            fsDropAttribute.__set__('fsSearchByValue', fs_search_by_value_stub);
            fsDropAttribute.__set__('fsDeleteRecords', fs_delete_records_stub)
        });

        it('Test error is thrown if search by value returns nothing', async () => {
            fs_search_by_value_stub.resolves([]);
            let test_err_result = await test_utils.testError(drop_attr_from_system(DROP_ATTR_OBJ_TEST), `Attribute ${DROP_ATTR_OBJ_TEST.attribute} was not found.`);

            expect(test_err_result).to.be.true;
        });

        it('Test for nominal behaviour and correct success message', async () => {
            let success_msg_fake = 'Successfully dropped attribute from system';
            fs_delete_records_stub.resolves(success_msg_fake);
            fs_search_by_value_stub.resolves(ATTRIBUTES_TEST);
            let result = await drop_attr_from_system(DROP_ATTR_OBJ_TEST);
            let search_obj_fake = {
                schema: "system",
                table: "hdb_attribute",
                hash_attribute: "id",
                search_attribute: "attribute",
                search_value: "another_attribute",
                get_attributes: [
                    "id"
                ]
            };

            let delete_table_obj_fake = {
                table: "hdb_attribute",
                schema: "system",
                hash_attribute: "id",
                hash_values: [
                    1
                ]
            };

            expect(result).to.equal(success_msg_fake);
            expect(fs_search_by_value_stub).to.have.been.calledWith(search_obj_fake);
            expect(fs_delete_records_stub).to.have.been.calledWith(delete_table_obj_fake);
        });
    });
});
