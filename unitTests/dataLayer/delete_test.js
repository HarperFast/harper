'use strict';

const test_utils = require('../test_utils');
test_utils.preTestPrep();

let DeleteResponseObject = require('../../dataLayer/DataLayerObjects').DeleteResponseObject;
const rewire = require('rewire');
const harperBridge = require('../../dataLayer/harperBridge/harperBridge');
const _delete = rewire('../../dataLayer/delete');
const log = require('../../utility/logging/harper_logger');
const hdb_utils = require('../../utility/common_utils');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const DELETE_BEFORE_OBJ = {
	operation: 'delete_files_before',
	date: '2018-06-14',
	schema: 'fish',
	table: 'thatFly',
};

const DELETE_TXN_BEFORE_OBJ = {
	operation: 'delete_audit_logs_before',
	timestamp: Date.now(),
	schema: 'fish',
	table: 'thatFly',
};

const DELETE_OBJ_TEST = {
	operation: 'delete',
	table: 'dogs',
	schema: 'animals',
	hash_values: ['id'],
};

let DELETE_RECORDS_TEST = {
	operation: 'delete',
	table: 'dogs',
	schema: 'animals',
	hash_values: [8, 9],
};

describe('Tests for delete.js', () => {
	let sandbox = sinon.createSandbox();
	let log_info_spy;
	let p_global_schema_stub = sandbox.stub();
	let schema_table_exist_stub;

	before(() => {
		log_info_spy = sandbox.spy(log, 'info');
		_delete.__set__('pGlobalSchema', p_global_schema_stub);
		schema_table_exist_stub = sandbox.stub(hdb_utils, 'checkSchemaTableExist').returns(undefined);
	});

	after(() => {
		sandbox.restore();
	});

	beforeEach(() => {
		schema_table_exist_stub.returns(undefined);
	});

	context('Test deleteFilesBeforeFunction', () => {
		let bridge_delete_before_stub;

		before(() => {
			bridge_delete_before_stub = sandbox.stub(harperBridge, 'deleteRecordsBefore');
		});

		it('Test that validation error returned', async () => {
			let delete_obj = test_utils.deepClone(DELETE_BEFORE_OBJ);
			delete delete_obj.date;
			let expected_error = test_utils.generateHDBError("'date' is required", 400);
			await test_utils.assertErrorAsync(_delete.deleteFilesBefore, [delete_obj], expected_error);
		});

		it('Test that Invalid date format error returned', async () => {
			let delete_obj = test_utils.deepClone(DELETE_BEFORE_OBJ);
			delete_obj.date = '03-09-2023';
			let test_err_result = await test_utils.testError(
				_delete.deleteFilesBefore(delete_obj),
				"'date' must be in ISO 8601 date format"
			);

			expect(test_err_result).to.be.true;
		});

		it('Test for nominal behaviour, bridge stubbed called and info logged', async () => {
			global.hdb_schema = {
				[DELETE_BEFORE_OBJ.schema]: {
					[DELETE_BEFORE_OBJ.table]: {},
				},
			};
			await _delete.deleteFilesBefore(DELETE_BEFORE_OBJ);

			expect(bridge_delete_before_stub).to.have.been.calledWith(DELETE_BEFORE_OBJ);
			expect(log_info_spy).to.have.been.calledWith(`Finished deleting files before ${DELETE_BEFORE_OBJ.date}`);
		});

		it('Test no schema error is returned', async () => {
			schema_table_exist_stub.returns(`database 'imnotaschema' does not exist`);
			global.hdb_schema = {
				[DELETE_RECORDS_TEST.schema]: {
					[DELETE_RECORDS_TEST.table]: {},
				},
			};
			let delete_obj_clone = test_utils.deepClone(DELETE_BEFORE_OBJ);
			let expected_error = test_utils.generateHDBError("database 'imnotaschema' does not exist", 404);
			delete_obj_clone.schema = 'imnotaschema';
			await test_utils.assertErrorAsync(_delete.deleteFilesBefore, [delete_obj_clone], expected_error);
		});
	});

	context('test deleteAuditLogsBefore function', () => {
		it('Test that validation error returned', async () => {
			let delete_obj = test_utils.deepClone(DELETE_TXN_BEFORE_OBJ);
			delete delete_obj.timestamp;
			let expected_error = test_utils.generateHDBError("'timestamp' is required", 400);
			await test_utils.assertErrorAsync(_delete.deleteAuditLogsBefore, [delete_obj], expected_error);
		});

		it('Test that date string is invalid', async () => {
			let delete_obj = test_utils.deepClone(DELETE_TXN_BEFORE_OBJ);
			delete_obj.timestamp = '03-09-2023';
			let expected_error = test_utils.generateHDBError("'timestamp' is invalid", 400);
			await test_utils.assertErrorAsync(_delete.deleteAuditLogsBefore, [delete_obj], expected_error);
		});

		it('Test that epoch value is valid', async () => {
			let delete_obj = test_utils.deepClone(DELETE_TXN_BEFORE_OBJ);
			delete_obj.timestamp = Date.now();
			let test_err_result = await test_utils.testError(_delete.deleteAuditLogsBefore(delete_obj), 'Invalid timestamp.');

			expect(test_err_result).to.be.false;
		});

		it('Test ok with stub', async () => {
			let bridge_delete_txns_stub = sandbox.stub(harperBridge, 'deleteAuditLogsBefore');

			global.hdb_schema = {
				[DELETE_BEFORE_OBJ.schema]: {
					[DELETE_BEFORE_OBJ.table]: {},
				},
			};
			let delete_obj = test_utils.deepClone(DELETE_TXN_BEFORE_OBJ);
			await _delete.deleteAuditLogsBefore(delete_obj);

			expect(bridge_delete_txns_stub).to.have.been.calledWith(DELETE_TXN_BEFORE_OBJ);
			expect(log_info_spy).to.have.been.calledWith(
				`Finished deleting audit logs before ${DELETE_TXN_BEFORE_OBJ.timestamp}`
			);
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
			let test_err_result = await test_utils.testError(
				_delete.deleteRecord(delete_obj),
				"'hash_values' must be an array"
			);

			expect(test_err_result).to.be.true;
		});

		it('Test for nominal behaviour, success msg is returned', async () => {
			global.hdb_schema = {
				[DELETE_RECORDS_TEST.schema]: {
					[DELETE_RECORDS_TEST.table]: {},
				},
			};
			let expected_response = new DeleteResponseObject();
			expected_response.deleted_hashes = [];
			expected_response.skipped_hashes = [8, 9];
			let delete_records_stub = sandbox.stub().resolves(expected_response);
			let revert = _delete.__set__('harperBridge', { deleteRecords: delete_records_stub });
			let result = await _delete.deleteRecord(DELETE_RECORDS_TEST);

			expect(delete_records_stub).to.have.been.calledWith(DELETE_RECORDS_TEST);
			expect(result).to.eql(expected_response);
			revert();
		});

		it('Test that error from bridge is caught and thrown', async () => {
			let error_msg = 'We have an error on the bridge';
			bridge_delete_records_stub.throws(new Error(error_msg));
			let test_err_result = await test_utils.testError(_delete.deleteRecord(DELETE_OBJ_TEST), error_msg);

			expect(test_err_result).to.be.true;
		});

		it('Test that error from schema/table check is handled', async () => {
			schema_table_exist_stub.returns(`database 'imnotaschema' does not exist`);
			global.hdb_schema = {
				[DELETE_RECORDS_TEST.schema]: {
					[DELETE_RECORDS_TEST.table]: {},
				},
			};
			let delete_obj_clone = test_utils.deepClone(DELETE_RECORDS_TEST);
			let expected_error = test_utils.generateHDBError("database 'imnotaschema' does not exist", 404);
			delete_obj_clone.schema = 'imnotaschema';
			await test_utils.assertErrorAsync(_delete.deleteRecord, [delete_obj_clone], expected_error);
		});
	});
});
