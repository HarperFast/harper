'use strict';

const test_utils = require('../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
const harperBridge = require('../../data_layer/harperBridge/harperBridge');
const _delete = rewire('../../data_layer/delete');
const log = require('../../utility/logging/harper_logger');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const DELETE_BEFORE_OBJ = {
    operation: 'delete_files_before',
    date: '2018-06-14',
    schema: 'fish',
    table: 'thatFly'
};

const DELETE_OBJ_TEST = {
    operation: 'delete',
    table: 'dogs',
    schema: 'animals',
    hash_values: ['id']
};

describe('Tests for delete.js', () => {
    let sandbox = sinon.createSandbox();
    let log_info_spy;
    let p_global_schema_stub = sandbox.stub();

    before(() => {
        log_info_spy = sandbox.spy(log, 'info');
        _delete.__set__('p_global_schema', p_global_schema_stub);
    });

    after(() => {
        sandbox.restore();
    });

    context('Test deleteFilesBeforeFunction', () => {
        let bridge_delete_before_stub;

        before(() => {
            bridge_delete_before_stub = sandbox.stub(harperBridge, 'deleteRecordsBefore');
        });

        it('Test that Invalid date error returned', async () => {
            let delete_obj = test_utils.deepClone(DELETE_BEFORE_OBJ);
            delete_obj.date = '';
            let test_err_result = await test_utils.testError(_delete.deleteFilesBefore(delete_obj), 'Invalid date.');

            expect(test_err_result).to.be.true;
        });

        it('Test that Invalid date format error returned', async () => {
            let delete_obj = test_utils.deepClone(DELETE_BEFORE_OBJ);
            delete_obj.date = '03-09-2023';
            let test_err_result = await test_utils.testError(_delete.deleteFilesBefore(delete_obj), 'Invalid date, must be in ISO-8601 format (YYYY-MM-DD).');

            expect(test_err_result).to.be.true;
        });

        it('Test that Invalid schema returned', async () => {
            let delete_obj = test_utils.deepClone(DELETE_BEFORE_OBJ);
            delete_obj.schema = '';
            let test_err_result = await test_utils.testError(_delete.deleteFilesBefore(delete_obj), 'Invalid schema.');

            expect(test_err_result).to.be.true;
        });

        it('Test that Invalid table error returned', async () => {
            let delete_obj = test_utils.deepClone(DELETE_BEFORE_OBJ);
            delete_obj.table = '';
            let test_err_result = await test_utils.testError(_delete.deleteFilesBefore(delete_obj), 'Invalid table.');

            expect(test_err_result).to.be.true;
        });

        it('Test for nominal behaviour, bridge stubbed called and info logged', async () => {
            await _delete.deleteFilesBefore(DELETE_BEFORE_OBJ);

            expect(bridge_delete_before_stub).to.have.been.calledWith(DELETE_BEFORE_OBJ);
            expect(log_info_spy).to.have.been.calledWith(`Finished deleting files before ${DELETE_BEFORE_OBJ.date}`);
        });
    });

    context('Test deleteRecords function', () => {
        let bridge_delete_records_stub;

        before(() => {
            bridge_delete_records_stub = sandbox.stub(harperBridge, 'deleteRecords');
        });

        it('Test that validation error is thrown from bad delete object', async () => {
            let delete_obj = test_utils.deepClone(DELETE_OBJ_TEST);
            delete_obj.hash_values = 'id';
            let test_err_result = await test_utils.testError(_delete.deleteRecord(delete_obj), 'Hash values hash_values has value id which is not an Array');

            expect(test_err_result).to.be.true;
        });

        it('Test for nominal behaviour, success msg is returned', async () => {
            let result = await _delete.deleteRecord(DELETE_OBJ_TEST);

            expect(bridge_delete_records_stub).to.have.been.calledWith(DELETE_OBJ_TEST);
            expect(result).to.equal('records successfully deleted');
        });

        it('Test that error from bridge is caught and thrown', async () => {
            let error_msg = 'We have an error on the bridge';
            bridge_delete_records_stub.throws(new Error(error_msg));
            let test_err_result = await test_utils.testError(_delete.deleteRecord(DELETE_OBJ_TEST), error_msg);

            expect(test_err_result).to.be.true;
        });
    });
});
