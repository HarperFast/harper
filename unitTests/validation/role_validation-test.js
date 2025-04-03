'use strict';

const test_utils = require('../test_utils');
test_utils.preTestPrep();

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');

const rewire = require('rewire');
const role_validation_rw = rewire('../../validation/role_validation');
let customValidate_rw = role_validation_rw.__get__('customValidate');
const { TEST_ROLE_PERMS_ERROR, TEST_SCHEMA_OP_ERROR } = require('../commonTestErrors');

let sandbox;
let customValidate_stub;
let validateObject_stub;

const TEST_HASH = 'id';
const TEST_SCHEMA = 'dev';
const DOG_TABLE_KEY = 'dev_dogs';
const CAT_TABLE_KEY = 'dev_cats';
const OWNER_TABLE_KEY = 'dev_owners';
const TEST_SCHEMA_VALS = {
	[TEST_SCHEMA]: {
		dogs: ['name', 'breed', 'owner_id', 'adorable'],
		cats: ['name', 'owner_id', 'annoying'],
		owners: ['name', 'age'],
	},
};

function setGlobalTestSchema() {
	Object.keys(TEST_SCHEMA_VALS.dev).forEach((table) => {
		test_utils.setGlobalSchema(TEST_HASH, TEST_SCHEMA, table, TEST_SCHEMA_VALS[TEST_SCHEMA][table]);
	});
}

const TEST_PERMISSIONS = () => ({
	permission: {
		super_user: false,
		dev: {
			tables: {
				dogs: {
					read: true,
					insert: true,
					update: true,
					delete: true,
					attribute_permissions: [],
				},
				cats: {
					read: false,
					insert: false,
					update: false,
					delete: false,
					attribute_permissions: [],
				},
				owners: {
					read: true,
					insert: false,
					update: false,
					delete: false,
					attribute_permissions: [
						{
							attribute_name: 'age',
							read: true,
							insert: false,
							update: false,
						},
						{
							attribute_name: 'name',
							read: false,
							insert: false,
							update: false,
						},
					],
				},
			},
		},
	},
});

const TEST_ADD_ROLE_OBJECT = () => ({
	operation: 'add_role',
	role: 'test_role',
	...TEST_PERMISSIONS(),
});

const TEST_ALTER_ROLE_OBJECT = () => ({
	operation: 'alter_role',
	id: 'TEST-ID-12345',
	...TEST_PERMISSIONS(),
});

const TEST_DROP_ROLE_OBJECT = {
	operation: 'drop_role',
	id: 'TEST-ID-12345',
};

const VALIDATION_CONSTRAINTS_OBJ = () => ({
	role: {
		presence: true,
		format: '[\\w\\-\\_]+',
	},
	id: {
		presence: true,
		format: '[\\w\\-\\_]+',
	},
	permission: {
		presence: true,
	},
});

function getAddRoleConstraints() {
	const constraints = VALIDATION_CONSTRAINTS_OBJ();
	constraints.role.presence = true;
	constraints.id.presence = false;
	constraints.permission.presence = true;
	return constraints;
}

function getAlterRoleConstraints() {
	const constraints = VALIDATION_CONSTRAINTS_OBJ();
	constraints.role.presence = false;
	constraints.id.presence = true;
	constraints.permission.presence = true;
	return constraints;
}

describe('Test role_validation module ', () => {
	before(() => {
		sandbox = sinon.createSandbox();
		validateObject_stub = sandbox.stub().returns(null);
		setGlobalTestSchema();
	});
	after(() => {
		global.hdb_schema = undefined;
	});

	describe('test exposed module functions', () => {
		const test_return_val = 'validator response value';
		let validateObject_reset;

		before(() => {
			customValidate_stub = sandbox.stub().returns(test_return_val);
			role_validation_rw.__set__('customValidate', customValidate_stub);
			validateObject_stub.returns(test_return_val);
			validateObject_reset = role_validation_rw.__set__('validator', { validateObject: validateObject_stub });
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		after(() => {
			sandbox.restore();
			validateObject_reset();
		});

		it('addRoleValidation() - nominal case - call and return results from customValidate', () => {
			const test_role_obj = TEST_ADD_ROLE_OBJECT();
			const test_result = role_validation_rw.addRoleValidation(test_role_obj);

			const customValidateArgs = customValidate_stub.args[0];

			expect(customValidateArgs[0]).to.deep.equal(test_role_obj);
			expect(customValidateArgs[1].role.presence).to.equal(true);
			expect(customValidateArgs[1].id.presence).to.equal(false);
			expect(customValidateArgs[1].permission.presence).to.equal(true);
			expect(test_result).to.equal(test_return_val);
		});

		it('alterRoleValidation() - nominal case - call and return results from customValidate', () => {
			const test_role_obj = TEST_ALTER_ROLE_OBJECT();
			const test_result = role_validation_rw.alterRoleValidation(test_role_obj);

			const customValidateArgs = customValidate_stub.args[0];

			expect(customValidateArgs[0]).to.deep.equal(test_role_obj);
			expect(customValidateArgs[1].role.presence).to.equal(false);
			expect(customValidateArgs[1].id.presence).to.equal(true);
			expect(customValidateArgs[1].permission.presence).to.equal(true);
			expect(test_result).to.equal(test_return_val);
		});

		it('dropRoleValidation() - nominal case - call and return results from validateObject', () => {
			const test_role_obj = TEST_DROP_ROLE_OBJECT;
			const test_result = role_validation_rw.dropRoleValidation(test_role_obj);

			const validateObjectArgs = validateObject_stub.args[0];

			expect(validateObjectArgs[0]).to.deep.equal(test_role_obj);
			expect(validateObjectArgs[1].role.presence).to.equal(false);
			expect(validateObjectArgs[1].id.presence).to.equal(true);
			expect(validateObjectArgs[1].permission.presence).to.equal(false);
			expect(test_result).to.equal(test_return_val);
		});
	});

	describe('customValidate() ', () => {
		it('NOMINAL - should return null for valid ADD_ROLE object', () => {
			const test_result = customValidate_rw(TEST_ADD_ROLE_OBJECT(), getAddRoleConstraints());

			expect(test_result).to.equal(null);
		});

		it('NOMINAL - should return null for valid SU ADD_ROLE object', () => {
			const test_role_json = TEST_ADD_ROLE_OBJECT();
			test_role_json.permission = { super_user: true };
			const test_result = customValidate_rw(test_role_json, getAddRoleConstraints());

			expect(test_result).to.equal(null);
		});

		it('NOMINAL - should return null for valid structure_user = true ADD_ROLE object', () => {
			const test_role_json = TEST_ADD_ROLE_OBJECT();
			test_role_json.permission = { structure_user: true };
			const test_result = customValidate_rw(test_role_json, getAddRoleConstraints());

			expect(test_result).to.equal(null);
		});

		it('NOMINAL - should return error for invalid structure_user = ["dev", "blah"] ADD_ROLE object', () => {
			const test_role_json = TEST_ADD_ROLE_OBJECT();
			test_role_json.permission = { structure_user: ['dev', 'blah'] };
			const test_result = customValidate_rw(test_role_json, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(1);
			expect(test_result.http_resp_msg.mainPermissions).to.include(TEST_SCHEMA_OP_ERROR.SCHEMA_NOT_FOUND('blah'));
		});

		it('NOMINAL - should return error for invalid structure_user = "wut" ADD_ROLE object', () => {
			const test_role_json = TEST_ADD_ROLE_OBJECT();
			test_role_json.permission = { structure_user: 'wut' };
			const test_result = customValidate_rw(test_role_json, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(1);
			expect(test_result.http_resp_msg.mainPermissions).to.eql([
				TEST_ROLE_PERMS_ERROR.STRUCTURE_USER_ROLE_TYPE_ERROR('structure_user'),
			]);
		});

		it('NOMINAL - should return null for valid structure_user = ["dev"] ADD_ROLE object', () => {
			const test_role_json = TEST_ADD_ROLE_OBJECT();
			test_role_json.permission = { structure_user: ['dev'] };
			const test_result = customValidate_rw(test_role_json, getAddRoleConstraints());

			expect(test_result).to.equal(null);
		});

		it('NOMINAL - should return null for valid ALTER_ROLE object', () => {
			const test_result = customValidate_rw(TEST_ALTER_ROLE_OBJECT(), getAlterRoleConstraints());
			expect(test_result).to.equal(null);
		});

		it('NOMINAL - should return null for valid SU ALTER_ROLE object', () => {
			const test_role_json = TEST_ALTER_ROLE_OBJECT();
			test_role_json.permission = { super_user: true };
			const test_result = customValidate_rw(test_role_json, getAlterRoleConstraints());
			expect(test_result).to.equal(null);
		});

		it('Invalid key in role_obj - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.super_admin = 'REJECT!';

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(1);
			expect(test_result.http_resp_msg.mainPermissions).to.include(
				TEST_ROLE_PERMS_ERROR.INVALID_ROLE_JSON_KEYS(['super_admin'])
			);
		});

		it('Invalid keys in role_obj - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.super_admin = 'REJECT!';
			test_role.invalid_key = true;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(1);
			expect(test_result.http_resp_msg.mainPermissions).to.include(
				TEST_ROLE_PERMS_ERROR.INVALID_ROLE_JSON_KEYS(['super_admin', 'invalid_key'])
			);
		});

		it('Role key missing from role_obj - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.role;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(1);
			expect(test_result.http_resp_msg.mainPermissions).to.include("Role can't be blank");
		});

		it('Permission key missing from role_obj - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(1);
			expect(test_result.http_resp_msg.mainPermissions).to.include("Permission can't be blank");
		});

		it('Role and permissions key missing from role_obj - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.role;
			delete test_role.permission;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(2);
			expect(test_result.http_resp_msg.mainPermissions).to.include("Permission can't be blank");
			expect(test_result.http_resp_msg.mainPermissions).to.include("Role can't be blank");
		});

		it('Role id missing from alter_role_obj - expect error returned', () => {
			const test_role = TEST_ALTER_ROLE_OBJECT();
			delete test_role.id;

			const test_result = customValidate_rw(test_role, getAlterRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(1);
			expect(test_result.http_resp_msg.mainPermissions).to.include("Id can't be blank");
		});

		it('Permission key missing from alter_role_obj - expect error returned', () => {
			const test_role = TEST_ALTER_ROLE_OBJECT();
			delete test_role.permission;

			const test_result = customValidate_rw(test_role, getAlterRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(1);
			expect(test_result.http_resp_msg.mainPermissions).to.include("Permission can't be blank");
		});

		it('Id and permissions key missing from alter_role_obj - expect error returned', () => {
			const test_role = TEST_ALTER_ROLE_OBJECT();
			delete test_role.id;
			delete test_role.permission;

			const test_result = customValidate_rw(test_role, getAlterRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(2);
			expect(test_result.http_resp_msg.mainPermissions).to.include("Permission can't be blank");
			expect(test_result.http_resp_msg.mainPermissions).to.include("Id can't be blank");
		});

		it('SU permission true w/ permissions - expect error thrown', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission.super_user = true;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.http_resp_msg.mainPermissions[0]).to.equal(
				TEST_ROLE_PERMS_ERROR.SU_CU_ROLE_NO_PERMS_ALLOWED('super_user')
			);
			expect(test_result.statusCode).to.equal(400);
		});

		it('CU permission true w/ permissions - expect error thrown', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission.super_user;
			test_role.permission.cluster_user = true;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.http_resp_msg.mainPermissions[0]).to.equal(
				TEST_ROLE_PERMS_ERROR.SU_CU_ROLE_NO_PERMS_ALLOWED('cluster_user')
			);
			expect(test_result.statusCode).to.equal(400);
		});

		it('CU and SU permission true - expect error thrown', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission = {
				cluster_user: true,
				super_user: true,
			};

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.http_resp_msg.mainPermissions[0]).to.equal(TEST_ROLE_PERMS_ERROR.SU_CU_ROLE_COMBINED_ERROR);
			expect(test_result.statusCode).to.equal(400);
		});

		it('Role_obj passed with no schema values - expect NO validation results', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission[TEST_SCHEMA];

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result).to.equal(null);
		});

		//Test missing CRUD values for a table
		it('Role_obj passed with missing table READ perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission[TEST_SCHEMA].tables.dogs.read;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_MISSING('read')
			);
		});

		it('Role_obj passed with missing table INSERT perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission[TEST_SCHEMA].tables.dogs.insert;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_MISSING('insert')
			);
		});

		it('Role_obj passed with missing table UPDATE perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission[TEST_SCHEMA].tables.dogs.update;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_MISSING('update')
			);
		});

		it('Role_obj passed with missing table DELETE perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission[TEST_SCHEMA].tables.dogs.delete;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_MISSING('delete')
			);
		});

		it('Role_obj passed with missing table CRUD perms - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission[TEST_SCHEMA].tables.dogs.read;
			delete test_role.permission[TEST_SCHEMA].tables.dogs.insert;
			delete test_role.permission[TEST_SCHEMA].tables.dogs.update;
			delete test_role.permission[TEST_SCHEMA].tables.dogs.delete;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(4);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_MISSING('read')
			);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_MISSING('insert')
			);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_MISSING('update')
			);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_MISSING('delete')
			);
		});

		it('Role_obj passed with missing table READ & INSERT perms - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission[TEST_SCHEMA].tables.dogs.read;
			delete test_role.permission[TEST_SCHEMA].tables.dogs.insert;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(2);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_MISSING('read')
			);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_MISSING('insert')
			);
		});

		//Test multiple table error response
		it('Role_obj passed with missing table READ & INSERT perms - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission[TEST_SCHEMA].tables.dogs.read;
			delete test_role.permission[TEST_SCHEMA].tables.dogs.insert;
			delete test_role.permission[TEST_SCHEMA].tables.cats.update;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(2);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_MISSING('read')
			);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_MISSING('insert')
			);
			expect(test_result.http_resp_msg.schemaPermissions[CAT_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[CAT_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_MISSING('update')
			);
		});

		//Test missing values for a attribute
		it('Role_obj passed with missing table attribute READ perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission[TEST_SCHEMA].tables.owners.attribute_permissions[0].read;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.ATTR_PERM_MISSING('read', 'age')
			);
		});

		it('Role_obj passed with missing table attribute INSERT perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission[TEST_SCHEMA].tables.owners.attribute_permissions[0].insert;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.ATTR_PERM_MISSING('insert', 'age')
			);
		});

		it('Role_obj passed with missing table attribute UPDATE perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission[TEST_SCHEMA].tables.owners.attribute_permissions[0].update;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.ATTR_PERM_MISSING('update', 'age')
			);
		});

		it('Role_obj passed with missing table attribute name key/value - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			delete test_role.permission[TEST_SCHEMA].tables.owners.attribute_permissions[0].attribute_name;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.ATTR_PERM_MISSING_NAME
			);
		});

		//Test perm value data type validation
		it('Role_obj passed with invalid table READ perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.dogs.read = 'Not a good value';

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_NOT_BOOLEAN('read')
			);
		});

		it('Role_obj passed with invalid table INSERT perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.dogs.insert = 'Not a good value';

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_NOT_BOOLEAN('insert')
			);
		});

		it('Role_obj passed with invalid table UPDATE perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.dogs.update = 'Not a good value';

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_NOT_BOOLEAN('update')
			);
		});

		it('Role_obj passed with invalid table DELETE perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.dogs.delete = 'Not a good value';

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY][0]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_NOT_BOOLEAN('delete')
			);
		});

		it('Role_obj passed with invalid table CRUD perms - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.dogs.read = 'Not a good value';
			test_role.permission[TEST_SCHEMA].tables.dogs.insert = 'Not a good value';
			test_role.permission[TEST_SCHEMA].tables.dogs.update = 'Not a good value';
			test_role.permission[TEST_SCHEMA].tables.dogs.delete = 'Not a good value';

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(4);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_NOT_BOOLEAN('read')
			);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_NOT_BOOLEAN('insert')
			);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_NOT_BOOLEAN('update')
			);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_NOT_BOOLEAN('delete')
			);
		});

		it('Role_obj passed with invalid table READ & INSERT perms - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.dogs.read = 'Not a good value';
			test_role.permission[TEST_SCHEMA].tables.dogs.insert = 'Not a good value';

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(2);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_NOT_BOOLEAN('read')
			);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_NOT_BOOLEAN('insert')
			);
		});

		//Test multiple table error response
		it('Role_obj passed with invalid READ & INSERT perm values across two tables - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.dogs.read = 'Not a good value';
			test_role.permission[TEST_SCHEMA].tables.dogs.insert = 'Not a good value';
			test_role.permission[TEST_SCHEMA].tables.cats.update = 'Not a good value';

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY].length).to.equal(2);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_NOT_BOOLEAN('read')
			);
			expect(test_result.http_resp_msg.schemaPermissions[DOG_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_NOT_BOOLEAN('insert')
			);
			expect(test_result.http_resp_msg.schemaPermissions[CAT_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[CAT_TABLE_KEY]).to.include(
				TEST_ROLE_PERMS_ERROR.TABLE_PERM_NOT_BOOLEAN('update')
			);
		});

		//Test missing values for an attribute
		it('Role_obj passed with invalid table attribute READ perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.owners.attribute_permissions[0].read = 'Not a good value';

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.ATTR_PERM_NOT_BOOLEAN('read', 'age')
			);
		});

		it('Role_obj passed with invalid table attribute INSERT perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.owners.attribute_permissions[0].insert = 'Not a good value';

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.ATTR_PERM_NOT_BOOLEAN('insert', 'age')
			);
		});

		it('Role_obj passed with invalid table attribute UPDATE perm - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.owners.attribute_permissions[0].update = 'Not a good value';

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.ATTR_PERM_NOT_BOOLEAN('update', 'age')
			);
		});

		it('Role_obj passed with invalid table attribute name key/value - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.owners.attribute_permissions[0].attribute_name = 12345;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.INVALID_ATTRIBUTE_IN_PERMS(12345)
			);
		});

		//Mismatched table/attr CRUD values
		it('Role_obj passed with mismatched table/table attribute CRUD perms - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.owners.attribute_permissions[0].insert = true;

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.MISMATCHED_TABLE_ATTR_PERMS('dev.owners')
			);
		});

		it('Role_obj passed with mutliple mismatched table/table attribute CRUD perms - expect error returned', () => {
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.owners.attribute_permissions[1].insert = true;
			test_role.permission[TEST_SCHEMA].tables.cats.attribute_permissions.push(
				test_role.permission[TEST_SCHEMA].tables.owners.attribute_permissions[1]
			);

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.MISMATCHED_TABLE_ATTR_PERMS('dev.owners')
			);
			expect(test_result.http_resp_msg.schemaPermissions[CAT_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[CAT_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.MISMATCHED_TABLE_ATTR_PERMS('dev.cats')
			);
		});

		//Incorrect/random keys in permissions object
		it('Role_obj passed with random key value in table permission - expect error returned', () => {
			const invalid_key = 'random_key';
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.owners[invalid_key] = 'oooops';

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.INVALID_PERM_KEY(invalid_key)
			);
		});

		it('Role_obj passed with random key value in table attr permission - expect error returned', () => {
			const invalid_key = 'random_key';
			const test_role = TEST_ADD_ROLE_OBJECT();
			test_role.permission[TEST_SCHEMA].tables.owners.attribute_permissions[0][invalid_key] = 'oooops';

			const test_result = customValidate_rw(test_role, getAddRoleConstraints());

			expect(test_result.statusCode).to.equal(400);
			expect(test_result.http_resp_msg.mainPermissions.length).to.equal(0);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY].length).to.equal(1);
			expect(test_result.http_resp_msg.schemaPermissions[OWNER_TABLE_KEY][0]).to.equal(
				TEST_ROLE_PERMS_ERROR.INVALID_ATTR_PERM_KEY(invalid_key)
			);
		});
	});
});
