'use strict';

const chai = require('chai');
const { expect } = chai;

const PermissionResponseObject = require('../../../security/data_objects/PermissionResponseObject');
const commonTestErrors = require('../../commonTestErrors');

const TEST_SCHEMA = 'dev',
	TEST_TABLE = 'dog',
	TEST_TABLE_KEY = `${TEST_SCHEMA}_${TEST_TABLE}`;

describe('Test PermissionResponseObject class', function () {
	describe('Test handleInvalidItem method - ', () => {
		it('should return response object w/ err message in invalid_schema_items', () => {
			const testPermResponse = new PermissionResponseObject();
			const test_err = 'Blaah blaah blaah. Fart.';
			const test_result = testPermResponse.handleInvalidItem(test_err);
			expect(test_result.error).to.equal(commonTestErrors.TEST_OPERATION_AUTH_ERROR.OP_AUTH_PERMS_ERROR);
			expect(test_result.invalid_schema_items.length).to.eql(1);
			expect(test_result.invalid_schema_items[0]).to.eql(test_err);
			expect(test_result.unauthorized_access.length).to.eql(0);
		});

		it('should return empty unauthorized_access array even if populated before', () => {
			const testPermResponse = new PermissionResponseObject();
			testPermResponse.unauthorized_access = ['Yada', 'Yadaaa'];
			const test_err = 'Blaah blaah blaah. Fart.';
			const test_result = testPermResponse.handleInvalidItem(test_err);
			expect(test_result.error).to.equal(commonTestErrors.TEST_OPERATION_AUTH_ERROR.OP_AUTH_PERMS_ERROR);
			expect(test_result.invalid_schema_items.length).to.eql(1);
			expect(test_result.invalid_schema_items[0]).to.eql(test_err);
			expect(test_result.unauthorized_access.length).to.eql(0);
		});
	});

	describe('Test addInvalidItem method - ', () => {
		it('should add item if schema_table key is not include unauthorized_access', () => {
			const testPermResponse = new PermissionResponseObject();
			const test_err = 'Blaah blaah blaah. Fart.';

			testPermResponse.addInvalidItem(test_err, TEST_SCHEMA, TEST_TABLE);

			expect(testPermResponse.error).to.equal(commonTestErrors.TEST_OPERATION_AUTH_ERROR.OP_AUTH_PERMS_ERROR);
			expect(testPermResponse.invalid_schema_items.length).to.eql(1);
			expect(testPermResponse.invalid_schema_items[0]).to.eql(test_err);
			expect(Object.keys(testPermResponse.unauthorized_access).length).to.eql(0);
		});

		it('should NOT add item if schema_table key is include unauthorized_access', () => {
			const testPermResponse = new PermissionResponseObject();
			const test_err = 'Blaah blaah blaah. Fart.';
			testPermResponse.unauthorized_access[TEST_TABLE_KEY] = {};

			testPermResponse.addInvalidItem(test_err, TEST_SCHEMA, TEST_TABLE);

			expect(testPermResponse.error).to.equal(commonTestErrors.TEST_OPERATION_AUTH_ERROR.OP_AUTH_PERMS_ERROR);
			expect(testPermResponse.invalid_schema_items.length).to.eql(0);
			expect(Object.keys(testPermResponse.unauthorized_access).length).to.eql(1);
		});
	});
});
