'use strict';

const assert = require('assert');
const terms = require('#src/utility/hdbTerms');
const {
	OPERATION_PERMISSION_GROUPS,
	expandOperationsPerms,
	validateOperations,
} = require('#src/utility/operationPermissions');

describe('operationPermissions', function () {
	describe('OPERATION_PERMISSION_GROUPS', function () {
		it('read_only contains expected read operations', function () {
			const ops = OPERATION_PERMISSION_GROUPS.read_only;
			assert.ok(ops.includes(terms.OPERATIONS_ENUM.SEARCH));
			assert.ok(ops.includes(terms.OPERATIONS_ENUM.SQL));
			assert.ok(ops.includes(terms.OPERATIONS_ENUM.DESCRIBE_ALL));
			assert.ok(ops.includes(terms.OPERATIONS_ENUM.USER_INFO));
		});

		it('read_only does not contain write operations', function () {
			const ops = OPERATION_PERMISSION_GROUPS.read_only;
			assert.ok(!ops.includes(terms.OPERATIONS_ENUM.INSERT));
			assert.ok(!ops.includes(terms.OPERATIONS_ENUM.UPDATE));
			assert.ok(!ops.includes(terms.OPERATIONS_ENUM.DELETE));
			assert.ok(!ops.includes(terms.OPERATIONS_ENUM.CSV_DATA_LOAD));
		});

		it('standard_user contains everything in read_only', function () {
			const readOnly = new Set(OPERATION_PERMISSION_GROUPS.read_only);
			for (const op of readOnly) {
				assert.ok(OPERATION_PERMISSION_GROUPS.standard_user.includes(op), `standard_user missing read_only op: ${op}`);
			}
		});

		it('standard_user contains data manipulation operations', function () {
			const ops = OPERATION_PERMISSION_GROUPS.standard_user;
			assert.ok(ops.includes(terms.OPERATIONS_ENUM.INSERT));
			assert.ok(ops.includes(terms.OPERATIONS_ENUM.UPDATE));
			assert.ok(ops.includes(terms.OPERATIONS_ENUM.UPSERT));
			assert.ok(ops.includes(terms.OPERATIONS_ENUM.DELETE));
		});

		it('standard_user does not contain token management operations', function () {
			const ops = OPERATION_PERMISSION_GROUPS.standard_user;
			assert.ok(!ops.includes(terms.OPERATIONS_ENUM.CREATE_AUTHENTICATION_TOKENS));
			assert.ok(!ops.includes(terms.OPERATIONS_ENUM.REFRESH_OPERATION_TOKEN));
		});

		it('standard_user does not contain schema DDL operations', function () {
			const ops = OPERATION_PERMISSION_GROUPS.standard_user;
			assert.ok(!ops.includes(terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE));
		});

		it('admin_read contains elevated read operations', function () {
			const ops = OPERATION_PERMISSION_GROUPS.admin_read;
			assert.ok(ops.includes(terms.OPERATIONS_ENUM.GET_CONFIGURATION));
			assert.ok(ops.includes(terms.OPERATIONS_ENUM.READ_LOG));
			assert.ok(ops.includes(terms.OPERATIONS_ENUM.READ_AUDIT_LOG));
			assert.ok(ops.includes(terms.OPERATIONS_ENUM.GET_CUSTOM_FUNCTIONS));
			assert.ok(ops.includes(terms.OPERATIONS_ENUM.GET_COMPONENTS));
		});

		it('admin_read does not contain data write operations', function () {
			const ops = OPERATION_PERMISSION_GROUPS.admin_read;
			assert.ok(!ops.includes(terms.OPERATIONS_ENUM.INSERT));
			assert.ok(!ops.includes(terms.OPERATIONS_ENUM.DELETE));
		});
	});

	describe('expandOperationsPerms()', function () {
		it('expands a group name to its member operations', function () {
			const result = expandOperationsPerms(['read_only']);
			assert.ok(result instanceof Set);
			assert.ok(result.has(terms.OPERATIONS_ENUM.SEARCH));
			assert.ok(result.has(terms.OPERATIONS_ENUM.SQL));
			assert.ok(result.has(terms.OPERATIONS_ENUM.DESCRIBE_ALL));
			assert.ok(result.has(terms.OPERATIONS_ENUM.USER_INFO));
		});

		it('group does not include write operations', function () {
			const result = expandOperationsPerms(['read_only']);
			assert.ok(!result.has(terms.OPERATIONS_ENUM.INSERT));
			assert.ok(!result.has(terms.OPERATIONS_ENUM.UPDATE));
			assert.ok(!result.has(terms.OPERATIONS_ENUM.DELETE));
			assert.ok(!result.has(terms.OPERATIONS_ENUM.CSV_DATA_LOAD));
		});

		it('passes through an individual operation name directly', function () {
			const result = expandOperationsPerms([terms.OPERATIONS_ENUM.RESTART]);
			assert.ok(result.has(terms.OPERATIONS_ENUM.RESTART));
			assert.equal(result.size, 1);
		});

		it('combines a group and individual operations into a union set', function () {
			const result = expandOperationsPerms([
				'read_only',
				terms.OPERATIONS_ENUM.RESTART,
				terms.OPERATIONS_ENUM.LIST_USERS,
			]);
			assert.ok(result.has(terms.OPERATIONS_ENUM.SEARCH));
			assert.ok(result.has(terms.OPERATIONS_ENUM.RESTART));
			assert.ok(result.has(terms.OPERATIONS_ENUM.LIST_USERS));
		});

		it('returns an empty set for an empty array', function () {
			const result = expandOperationsPerms([]);
			assert.equal(result.size, 0);
		});
	});

	describe('validateOperations()', function () {
		it('returns null for valid individual operations', function () {
			assert.strictEqual(validateOperations([terms.OPERATIONS_ENUM.INSERT, terms.OPERATIONS_ENUM.SEARCH]), null);
		});

		it('returns null for valid group names', function () {
			assert.strictEqual(validateOperations(['read_only', 'admin_read']), null);
		});

		it('returns null for a mix of operations and group names', function () {
			assert.strictEqual(validateOperations(['read_only', terms.OPERATIONS_ENUM.RESTART]), null);
		});

		it('returns null for an empty array', function () {
			assert.strictEqual(validateOperations([]), null);
		});

		it('returns the invalid entry for an unknown operation', function () {
			assert.strictEqual(validateOperations(['totally_fake_op']), 'totally_fake_op');
		});

		it('returns the first invalid entry when multiple are invalid', function () {
			const result = validateOperations([terms.OPERATIONS_ENUM.INSERT, 'bad_one', 'bad_two']);
			assert.strictEqual(result, 'bad_one');
		});

		it('returns a stringified value for non-string entries', function () {
			assert.strictEqual(validateOperations([123]), '123');
			assert.strictEqual(validateOperations([null]), 'null');
			assert.strictEqual(validateOperations([undefined]), 'undefined');
		});
	});
});
