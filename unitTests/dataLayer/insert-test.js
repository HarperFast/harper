'use strict';

const test_utils = require('../test_utils');

const rewire = require('rewire');
const insert_rw = rewire('../../dataLayer/insert');
const assert = require('assert');
const sinon = require('sinon');

const UPSERT_OBJECT_TEST = {
	operation: 'upsert',
	schema: 'dev',
	table: 'dog',
	records: [
		{
			name: 'Harper',
			breed: 'Mutt',
			id: '1',
			age: 5,
		},
		{
			name: 'Penny',
			breed: 'Mutt',
			id: '2',
			age: 5,
			height: 145,
		},
	],
};

const TEST_BRIDGE_UPSERT_RESP = {
	written_hashes: [1, 2],
	txn_time: 12345,
	new_attributes: [],
};

const EXPECTED_UPSERT_RESP = {
	message: 'upserted 2 of 2 records',
	upserted_hashes: [1, 2],
	txn_time: 12345,
	new_attributes: [],
};

const sandbox = sinon.createSandbox();

describe('Test insert module', () => {
	let check_schema_stub = sandbox.stub().returns(null);
	let is_empty_stub = sandbox.stub().returns(false);
	let transform_stub = sandbox.stub();

	beforeEach(() => {
		check_schema_stub.returns(null);
	});

	before(() => {
		insert_rw.__set__('hdbUtils', {
			checkSchemaTableExist: check_schema_stub,
			isEmpty: is_empty_stub,
			transformReq: transform_stub,
		});
	});

	after(() => {
		rewire('../../dataLayer/insert');
	});

	describe('Test upsert method', () => {
		let bridge_upsert_stub;

		before(() => {
			bridge_upsert_stub = sandbox.stub().returns(TEST_BRIDGE_UPSERT_RESP);
		});

		beforeEach(() => {
			insert_rw.__set__('harperBridge', { upsertRecords: bridge_upsert_stub });
		});

		afterEach(async () => {
			sandbox.restore();
		});

		it('NOMINAL - should return upsert response with upserted_hashes value', async () => {
			let results = await test_utils.assertErrorAsync(insert_rw.upsert, [UPSERT_OBJECT_TEST], undefined);
			assert.deepStrictEqual(results, EXPECTED_UPSERT_RESP);
		});

		it('Should return HdbError if operation is not upsert', async () => {
			const upsert_obj = test_utils.deepClone(UPSERT_OBJECT_TEST);
			upsert_obj.operation = 'insert';
			const expected_err = test_utils.generateHDBError('invalid operation, must be upsert', 500);
			await test_utils.assertErrorAsync(insert_rw.upsert, [upsert_obj], expected_err);
		});

		it('Should return HdbError if there is a schema validation error', async () => {
			const test_err_msg = 'Schema error!';
			check_schema_stub.returns(test_err_msg);
			const expected_err = test_utils.generateHDBError(test_err_msg, 400);
			await test_utils.assertErrorAsync(insert_rw.upsert, [UPSERT_OBJECT_TEST], expected_err);
		});

		it('Should return HdbError if insertValidator returns error', async () => {
			const upsert_obj = test_utils.deepClone(UPSERT_OBJECT_TEST);
			upsert_obj.schema = 'schem/a';
			const expected_err = test_utils.generateHDBError(
				"'schema' names cannot include backticks or forward slashes",
				400
			);
			await test_utils.assertErrorAsync(insert_rw.upsert, [upsert_obj], expected_err);
		});
	});

	describe('Test returnObject method', () => {
		let returnObject_rw;
		let ACTION_ENUM = {
			INSERT: 'inserted',
			UPDATE: 'updated',
			UPSERT: 'upserted',
		};
		let test_args = {
			written_hashes: [1, 2],
			skipped_hashes: [3, 4],
			new_attributes: ['name', 'breed'],
			txn_time: 123456789,
		};
		let EXPECTED_MESSAGE = (action, written, total) => `${action} ${written} of ${total} records`;

		before(() => {
			returnObject_rw = insert_rw.__get__('returnObject');
		});

		it('Test for INSERT', async () => {
			let result = returnObject_rw(
				ACTION_ENUM.INSERT,
				test_args.written_hashes,
				test_args,
				test_args.skipped_hashes,
				test_args.new_attributes,
				test_args.txn_time
			);
			assert.equal(result.message, EXPECTED_MESSAGE(ACTION_ENUM.INSERT, 2, 4));
		});

		it('Test for UPDATE', async () => {
			let result = returnObject_rw(
				ACTION_ENUM.UPDATE,
				test_args.written_hashes,
				test_args,
				test_args.skipped_hashes,
				test_args.new_attributes,
				test_args.txn_time
			);
			assert.equal(result.message, EXPECTED_MESSAGE(ACTION_ENUM.UPDATE, 2, 4));
		});

		it('Test for UPSERT', async () => {
			let result = returnObject_rw(
				ACTION_ENUM.UPSERT,
				test_args.written_hashes,
				test_args,
				[],
				test_args.new_attributes,
				test_args.txn_time
			);
			assert.equal(result.message, EXPECTED_MESSAGE(ACTION_ENUM.UPSERT, 2, 2));
		});
	});

	describe('Test insertData method', () => {
		const insert_object_test = test_utils.deepClone(UPSERT_OBJECT_TEST);
		insert_object_test.operation = 'insert';
		const bridge_insert_resp_test = {
			written_hashes: ['123d2', '312312'],
			skipped_hashes: ['123fd2'],
			new_attributes: ['height', 'age'],
			txn_time: 12345,
		};
		let bridge_insert_stub = sandbox.stub().resolves(bridge_insert_resp_test);

		before(() => {
			insert_rw.__set__('harperBridge', { createRecords: bridge_insert_stub });
		});

		after(() => {
			sandbox.restore();
		});

		it('NOMINAL - should return insert response with inserted_hashes value', async () => {
			const expected_insert_resp = {
				message: 'inserted 2 of 3 records',
				new_attributes: ['height', 'age'],
				txn_time: 12345,
				inserted_hashes: ['123d2', '312312'],
				skipped_hashes: ['123fd2'],
			};
			const results = await test_utils.assertErrorAsync(insert_rw.insert, [insert_object_test], undefined);
			assert.deepStrictEqual(results, expected_insert_resp);
		});

		it('Should return HdbError if operation is not insert', async () => {
			const insert_obj = test_utils.deepClone(insert_object_test);
			insert_obj.operation = 'upsert';
			await test_utils.assertErrorAsync(insert_rw.insert, [insert_obj], new Error('invalid operation, must be insert'));
		});

		it('Should return HdbError if insertValidator returns error', async () => {
			const insert_obj = test_utils.deepClone(insert_object_test);
			insert_obj.schema = 'schem`a';
			const expected_err = test_utils.generateHDBError(
				"'schema' names cannot include backticks or forward slashes",
				400
			);
			await test_utils.assertErrorAsync(insert_rw.insert, [insert_obj], expected_err);
		});

		it('Should return HdbError if schema table does not exist', async () => {
			const test_err_msg = 'Table does not exist';
			check_schema_stub.returns(test_err_msg);
			const expected_err = test_utils.generateHDBError(test_err_msg, 400);
			await test_utils.assertErrorAsync(insert_rw.insert, [insert_object_test], expected_err);
		});
	});

	describe('Test updateData method', () => {
		const update_object_test = test_utils.deepClone(UPSERT_OBJECT_TEST);
		update_object_test.operation = 'update';
		let bridge_update_stub = sandbox.stub();

		const bridge_update_resp_test = {
			written_hashes: ['123d2', '312312'],
			skipped_hashes: ['123fd2'],
			new_attributes: ['height', 'age'],
			txn_time: 12345,
		};

		before(() => {
			insert_rw.__set__('harperBridge', { updateRecords: bridge_update_stub });
		});

		after(() => {
			sandbox.restore();
		});

		it('NOMINAL - should return update response with updated_hashes value with existing rows', async () => {
			bridge_update_stub.resolves({
				update_action: 'update',
				hashes: ['123d2', '312312'],
				existing_rows: ['35tff'],
				txn_time: 12345,
			});
			const expected_update_resp = {
				message: 'update 0 of 2 records',
				new_attributes: undefined,
				txn_time: 12345,
				update_hashes: [],
				skipped_hashes: ['123d2', '312312'],
			};

			const results = await test_utils.assertErrorAsync(insert_rw.update, [update_object_test], undefined);
			assert.deepStrictEqual(results, expected_update_resp);
		});

		it('NOMINAL - should return update response with updated_hashes value with out existing rows', async () => {
			bridge_update_stub.resolves({
				update_action: 'update',
				written_hashes: ['123d2', '312312'],
				skipped_hashes: ['35tff'],
				new_attributes: ['age'],
				txn_time: 12345,
			});
			is_empty_stub.returns(true);
			const expected_update_resp = {
				message: 'updated 2 of 3 records',
				new_attributes: ['age'],
				txn_time: 12345,
				update_hashes: ['123d2', '312312'],
				skipped_hashes: ['35tff'],
			};

			const results = await test_utils.assertErrorAsync(insert_rw.update, [update_object_test], undefined);
			assert.deepStrictEqual(results, expected_update_resp);
		});

		it('Should return HdbError if operation is not update', async () => {
			const update_obj = test_utils.deepClone(update_object_test);
			update_obj.operation = 'upsert';
			await test_utils.assertErrorAsync(insert_rw.update, [update_obj], new Error('invalid operation, must be update'));
		});

		it('Should return HdbError if insertValidator returns error', async () => {
			const update_obj = test_utils.deepClone(update_object_test);
			update_obj.schema = '';
			const expected_err = test_utils.generateHDBError("'schema' is not allowed to be empty", 400);
			await test_utils.assertErrorAsync(insert_rw.update, [update_obj], expected_err);
		});

		it('Should return HdbError if schema table does not exist', async () => {
			const test_err_msg = 'Table does not exist';
			check_schema_stub.returns(test_err_msg);
			const expected_err = test_utils.generateHDBError(test_err_msg, 400);
			await test_utils.assertErrorAsync(insert_rw.update, [update_object_test], expected_err);
		});
	});
});
