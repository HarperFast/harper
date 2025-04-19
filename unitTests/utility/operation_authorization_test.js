'use strict';
/**
 * Test the operation_authorization module.
 */
const chai = require('chai');
const { expect } = chai;
const test_utils = require('../test_utils');
test_utils.preTestPrep();
const assert = require('assert');
const _ = require('lodash');
const rewire = require('rewire');
const op_auth = require('../../utility/operation_authorization');
const op_auth_rewire = rewire('../../utility/operation_authorization');
const Permission_rw = op_auth_rewire.__get__('permission');
const write = require('../../dataLayer/insert');
const user = require('../../security/user');
const alasql = require('alasql');
const search = require('../../dataLayer/search');
const jobs = require('../../server/jobs/jobs');
const terms = require('../../utility/hdbTerms');
const schema = require('../../dataLayer/schema');
const PermissionResponseObject = require('../../security/data_objects/PermissionResponseObject');
const PermissionTableResponseObject = require('../../security/data_objects/PermissionTableResponseObject');
const PermissionAttributeResponseObject = require('../../security/data_objects/PermissionAttributeResponseObject');
const { TEST_SCHEMA_OP_ERROR, TEST_OPERATION_AUTH_ERROR } = require('../commonTestErrors');

const serverUtilities_rw = rewire('../../server/serverHelpers/serverUtilities');
const initializeOperationFunctionMap_rw = serverUtilities_rw.__get__('initializeOperationFunctionMap');
const OPERATION_MAP = initializeOperationFunctionMap_rw();
rewire('../../server/serverHelpers/serverUtilities');

const test_terms = test_utils.COMMON_TEST_TERMS;
const crud_keys = test_terms.TEST_CRUD_PERM_KEYS;

let EMPTY_PERMISSION = {
	super_user: false,
};

let TEST_SELECT_WILDCARD_JSON = {
	columns: [
		{
			columnid: '*',
		},
	],
	from: [
		{
			databaseid: 'dev',
			tableid: 'dog',
		},
	],
	where: {
		expression: {
			left: {
				columnid: 'id',
			},
			op: '=',
			right: {
				value: 1,
			},
		},
	},
};

let TEST_INSERT_JSON = {
	into: {
		databaseid: 'dev',
		tableid: 'dog',
	},
	columns: [
		{
			columnid: 'id',
		},
		{
			columnid: 'name',
		},
	],
	values: [
		[
			{
				value: 22,
			},
			{
				value: 'Simon',
			},
		],
	],
};

let TEST_JSON = {
	operation: 'insert',
	schema: 'dev',
	table: 'dog',
	records: [
		{
			name: 'Harper',
			breed: 'Mutt',
			id: '111',
			age: 5,
		},
		{
			name: 'Penny',
			breed: 'Mutt',
			id: '333',
			age: 5,
		},
	],
	hdb_user: {
		active: true,
		role: {
			id: '9c9aae33-4d1d-40b5-a52e-bbbc1b2e2ba6',
			permission: {
				super_user: false,
				dev: {
					tables: {
						dog: {
							read: true,
							insert: true,
							update: true,
							delete: true,
							attribute_permissions: [],
						},
					},
				},
			},
			role: 'no_perms',
		},
		username: 'user_1',
	},
};

const STRUCTURE_USER_OP = {
	operation: null,
	hdb_user: {
		active: true,
		role: {
			id: '12345',
			permission: {
				structure_user: true,
			},
			role: 'structure',
		},
		username: 'cool_guy',
	},
};

const STRUCTURE_USER_OP2 = {
	operation: null,
	hdb_user: {
		active: true,
		role: {
			id: '123456',
			permission: {
				structure_user: ['dev'],
			},
			role: 'structure',
		},
		username: 'cool_guy',
	},
};

let TEST_ACTION_JSON = {
	operation: 'csvDataLoad',
	action: 'insert',
	schema: 'dev',
	table: 'dog',
	data: 'name,breed,id,age\nHarper,Mutt,111,5\nPenny,Mutt,333,5\n',
	hdb_user: {
		active: true,
		role: {
			id: '9c9aae33-4d1d-40b5-a52e-bbbc1b2e2ba6',
			permission: {
				super_user: false,
				dev: {
					tables: {
						dog: {
							read: true,
							insert: true,
							update: true,
							delete: true,
							attribute_permissions: [],
						},
					},
				},
			},
			role: 'no_perms',
		},
		username: 'user_2',
	},
};

let TEST_CONDITIONS_JSON = {
	operation: 'search_by_conditions',
	schema: 'dev',
	table: 'dog',
	get_attributes: ['id', 'age', 'name', 'adorable', 'location'],
	conditions: [
		{
			search_attribute: 'location',
			search_type: 'contains',
			search_value: 'NC',
		},
		{
			search_attribute: 'location',
			search_type: 'contains',
			search_value: 'CO',
		},
		{
			search_attribute: 'age',
			search_type: 'contains',
			search_value: 'CO',
		},
		{
			search_attribute: 'owner_name',
			search_type: 'contains',
			search_value: 'CO',
		},
	],
};

let TEST_SEARCH_BY_VAL_JSON = {
	operation: 'search_by_value',
	schema: 'dev',
	table: 'dog',
	get_attributes: ['id', 'name', 'adorable', 'location'],
	search_attribute: 'age',
	search_value: 10,
};

let TEST_JSON_SUPER_USER = {
	operation: 'insert',
	schema: 'dev',
	table: 'dog',
	records: [
		{
			name: 'Harper',
			breed: 'Mutt',
			id: '111',
			age: 5,
		},
		{
			name: 'Penny',
			breed: 'Mutt',
			id: '333',
			age: 5,
		},
	],
	hdb_user: {
		active: true,
		role: {
			id: '9c9aae33-4d1d-40b5-a52e-bbbc1b2e2ba6',
			permission: {
				super_user: true,
				dev: {
					tables: {
						dog: {
							read: true,
							insert: true,
							update: true,
							delete: true,
							attribute_permissions: [],
						},
					},
				},
			},
			role: 'no_perms',
		},
		username: 'super_user_1',
	},
};

let PERMISSION_BASE = {
	super_user: false,
	dev: {
		describe: false,
		tables: {
			dog: {
				describe: false,
				read: false,
				insert: false,
				update: false,
				delete: false,
				attribute_permissions: [],
			},
		},
	},
};

const TEST_SCHEMA = 'dev';
const TEST_TABLE = 'dog';
let TEST_ATTRIBUTES = ['name', 'breed', 'id', 'age'];
let RESTRICTED_ATTRIBUTES = ['breed', 'age'];
let RESTRICTED_ATTRIBUTES_2 = ['name', 'id'];
let AFFECTED_ATTRIBUTES_SET = new Set(TEST_ATTRIBUTES);

let ROLE_PERMISSION_KEY = 'name';
let HASH_ATTR_KEY = 'id';

function generateAttrPerms(crud_key, crud_value) {
	const attr_perms = {
		read: false,
		insert: true,
		update: false,
	};
	if (crud_key) {
		attr_perms[crud_key] = crud_value;
	}
	return attr_perms;
}

let ATTRIBUTE_PERMISSION_BASE = (attrs, crud_key, crud_value) => {
	const final_attribute_permissions = [];
	attrs.forEach((attr) => {
		const attr_perms = generateAttrPerms(crud_key, crud_value);
		final_attribute_permissions.push({
			attribute_name: attr,
			describe: Object.values(attr_perms).map((attr) => attr).length > 0,
			...attr_perms,
		});
	});
	return final_attribute_permissions;
};

const DEFAULT_ATTRIBUTE_PERMISSION_BASE = () => ATTRIBUTE_PERMISSION_BASE([ROLE_PERMISSION_KEY]);

let ROLE_ATTRIBUTE_RESTRICTIONS = new Map();
TEST_ATTRIBUTES.forEach((attr) => {
	ROLE_ATTRIBUTE_RESTRICTIONS.set(attr, ATTRIBUTE_PERMISSION_BASE([attr])[0]);
});

const test_attrs = [{ attribute: '__createdtime__' }, { attribute: '__updatedtime__' }];
AFFECTED_ATTRIBUTES_SET.forEach((attr) => test_attrs.push({ attribute: attr }));

/*
    This is a simple, naive clone implementation.  It should never, ever! be used in prod.
 */
function clone(a) {
	return JSON.parse(JSON.stringify(a));
}

let roleUpdatedTimeCounter = 12345;
function getRequestJson(req_obj) {
	const final_req_obj = clone(req_obj);
	final_req_obj.hdb_user.role.__updatedtime__ = roleUpdatedTimeCounter += 1;
	return final_req_obj;
}

describe('Test operation_authorization', function () {
	before(() => {
		global.hdb_schema = {
			[TEST_JSON.schema]: {
				[TEST_JSON.table]: {
					hash_attribute: 'id',
					attributes: [...test_attrs],
				},
			},
		};
	});

	after(() => {
		global.hdb_schema = undefined;
	});

	const JOB_OP_FUNC_KEYS = ['executeJob'];
	function getOperationFuncName(op) {
		const { operation_function, job_operation_function } = op;
		let finalOp = operation_function.name;
		if (JOB_OP_FUNC_KEYS.includes(finalOp)) {
			finalOp = job_operation_function.name;
		}
		return finalOp;
	}

	it('required_permissions should include settings for all API operations', function () {
		const require_perms_rw = op_auth_rewire.__get__('requiredPermissions');
		const missing_ops = [];
		OPERATION_MAP.forEach((required_op, key, map) => {
			const test_op = getOperationFuncName(required_op);
			//evaluateSQL op breaks down to a specific SQL query type operation that is used in perms check so we need
			// to test those values instead of evaluateSQL.  All of those values
			if (test_op === 'evaluateSQL') {
				Object.values(terms.VALID_SQL_OPS_ENUM).forEach((op) => {
					if (!require_perms_rw.has(op)) {
						missing_ops.push(test_op);
					}
				});
			} else if (!require_perms_rw.has(test_op)) {
				missing_ops.push(test_op);
			}
		});

		assert.deepEqual(missing_ops, []);
	});

	describe(`Test verifyPermsAst`, function () {
		it('NOMINAL, test verify with proper syntax, expect true', function () {
			let test_json = clone(TEST_INSERT_JSON);
			let temp_insert = new alasql.yy.Insert(test_json);
			let req_json = getRequestJson(TEST_JSON);
			req_json.hdb_user.role.permission.dev.tables.dog.insert = true;
			let att_base = DEFAULT_ATTRIBUTE_PERMISSION_BASE();
			req_json.hdb_user.role.permission.dev.tables.dog.attribute_permissions = att_base;
			let result = op_auth_rewire.verifyPermsAst(temp_insert, req_json.hdb_user, write.insert.name);
			assert.equal(result, null);
		});

		it('Test verify AST with table insert perm false, expect false', function () {
			let test_json = clone(TEST_INSERT_JSON);
			let temp_insert = new alasql.yy.Insert(test_json);
			let req_json = getRequestJson(TEST_JSON);
			req_json.hdb_user.role.permission.dev.tables.dog.insert = false;
			let result = op_auth_rewire.verifyPermsAst(temp_insert, req_json.hdb_user, write.insert.name);
			assert.equal(result.unauthorized_access.length, 1);
			assert.equal(result instanceof PermissionResponseObject, true);
			assert.equal(result.unauthorized_access[0] instanceof PermissionTableResponseObject, true);
		});

		it('Test verify AST with table perm true but all attr perms false, expect false', function () {
			let test_json = clone(TEST_INSERT_JSON);
			let temp_insert = new alasql.yy.Insert(test_json);
			let req_json = getRequestJson(TEST_JSON);
			req_json.hdb_user.role.permission.dev.tables.dog.insert = true;
			let att_base = DEFAULT_ATTRIBUTE_PERMISSION_BASE();
			att_base[0].insert = false;
			req_json.hdb_user.role.permission.dev.tables.dog.attribute_permissions = att_base;
			let result = op_auth_rewire.verifyPermsAst(temp_insert, req_json.hdb_user, write.insert.name);
			assert.equal(result.invalid_schema_items.length, 2);
			assert.equal(result instanceof PermissionResponseObject, true);
			assert.equal(result.unauthorized_access.length, 0);
		});

		it('Test with bad operations, expect false', function () {
			let test_json = clone(TEST_INSERT_JSON);
			let temp_insert = new alasql.yy.Insert(test_json);
			let req_json = getRequestJson(TEST_JSON);
			req_json.hdb_user.role.permission.dev.tables.dog.insert = true;
			let att_base = ATTRIBUTE_PERMISSION_BASE([]);
			req_json.hdb_user.role.permission.dev.tables.dog.attribute_permissions = att_base;
			let test_err;
			try {
				op_auth_rewire.verifyPermsAst(temp_insert, req_json.hdb_user, 'fart');
			} catch (e) {
				test_err = e;
			}
			assert.equal(test_err.statusCode, 400);
			assert.equal(test_err.http_resp_msg, "Operation 'fart' not found");
		});

		it(`Test select wildcard with proper perms, expect true`, function () {
			let test_json = clone(TEST_SELECT_WILDCARD_JSON);
			let temp_select = new alasql.yy.Select(test_json);
			let req_json = getRequestJson(TEST_JSON);
			req_json.hdb_user.role.permission.dev.tables.dog.read = true;
			let att_base = DEFAULT_ATTRIBUTE_PERMISSION_BASE();
			att_base[0].read = true;
			req_json.hdb_user.role.permission.dev.tables.dog.attribute_permissions = att_base;
			let result = op_auth_rewire.verifyPermsAst(temp_select, req_json.hdb_user, search.search.name);
			assert.equal(result, null);
		});

		it(`Test select wildcard with read attribute restriction false, expect false`, function () {
			let test_json = clone(TEST_SELECT_WILDCARD_JSON);
			let temp_select = new alasql.yy.Select(test_json);
			let req_json = getRequestJson(TEST_JSON);
			req_json.hdb_user.role.permission.dev.tables.dog.read = true;
			let att_base = DEFAULT_ATTRIBUTE_PERMISSION_BASE();
			req_json.hdb_user.role.permission.dev.tables.dog.attribute_permissions = att_base;
			let result = op_auth_rewire.verifyPermsAst(temp_select, req_json.hdb_user, search.search.name);
			assert.equal(result.unauthorized_access.length, 1);
			assert.equal(result.invalid_schema_items.length, 0);
			assert.equal(result instanceof PermissionResponseObject, true);
			assert.equal(result.unauthorized_access[0] instanceof PermissionTableResponseObject, true);
		});

		it('Test select wildcard with one attribute permission true, expect true', function () {
			let test_json = clone(TEST_SELECT_WILDCARD_JSON);
			let temp_select = new alasql.yy.Select(test_json);
			let req_json = getRequestJson(TEST_JSON);
			req_json.hdb_user.role.permission.dev.tables.dog.read = true;
			let att_base = ATTRIBUTE_PERMISSION_BASE([ROLE_PERMISSION_KEY], crud_keys.READ, true);
			req_json.hdb_user.role.permission.dev.tables.dog.attribute_permissions = att_base;
			let result = op_auth_rewire.verifyPermsAst(temp_select, req_json.hdb_user, search.search.name);
			assert.equal(result, null);
		});

		it('Test cannot delete from system table error returned', () => {
			let ast_test = {
				table: {
					databaseid: 'system',
					tableid: 'hdb_user',
				},
				where: {
					left: {
						columnid: 'id',
					},
					op: '=',
					right: {
						value: 1,
					},
				},
			};
			let temp_delete = new alasql.yy.Delete(ast_test);
			let req_json = getRequestJson(TEST_JSON);
			let expected_error = test_utils.generateHDBError(
				"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed.",
				403
			);
			test_utils.assertErrorSync(
				op_auth_rewire.verifyPermsAst,
				[temp_delete, req_json.hdb_user, 'delete'],
				expected_error
			);
		});
	});

	describe(`Test verifyPerms`, function () {
		it('Pass in bad values, expect false', function () {
			let test_err;
			try {
				op_auth.verifyPerms(null, null);
			} catch (e) {
				test_err = e;
			}

			assert.equal(test_err.http_resp_msg, 'Invalid request');
			assert.equal(test_err.statusCode, 400);
		});

		it('Check return if user has su.  Expect true', function () {
			let result = op_auth.verifyPerms(TEST_JSON_SUPER_USER, write.insert.name);
			assert.equal(result, null);
		});

		it('Pass function instead of function name.  Expect empty array (no errors)', function () {
			let result = op_auth.verifyPerms(TEST_JSON, write.insert);
			assert.equal(result, null);
		});

		it('Pass function name instead of function.  Expect empty array (no errors)', function () {
			assert.equal(op_auth.verifyPerms(TEST_JSON, write.insert.name), null);
		});

		it('Pass in JSON with no schemas restrictions defined, expect invalid schema error', function () {
			let req_json = getRequestJson(TEST_JSON);
			req_json.hdb_user.role.permission = EMPTY_PERMISSION;
			const result = op_auth.verifyPerms(req_json, write.insert.name);
			assert.equal(result instanceof PermissionResponseObject, true);
			assert.equal(result.invalid_schema_items.length, 1);
			assert.equal(result.unauthorized_access.length, 0);
		});

		it('Pass in JSON with schemas but no table perms defined, expect perms errors', function () {
			let req_json = getRequestJson(TEST_JSON);
			let perms = {
				super_user: false,
				dev: {
					tables: {},
				},
				test: {
					tables: {},
				},
			};
			req_json.hdb_user.role.permission = perms;
			const result = op_auth.verifyPerms(req_json, write.insert.name);
			assert.equal(result.invalid_schema_items.length, 1);
			assert.equal(result.unauthorized_access.length, 0);
		});

		it('Pass in JSON with schemas and table dog defined but describe false for all, expect invalid schema result', function () {
			let req_json = getRequestJson(TEST_JSON);
			let perms = clone(PERMISSION_BASE);
			perms['dev'].tables['dog'].insert = false;
			req_json.hdb_user.role.permission = perms;
			let result = op_auth_rewire.verifyPerms(req_json, write.insert.name);
			assert.equal(result instanceof PermissionResponseObject, true);
			assert.equal(result.invalid_schema_items.length, 1);
			assert.equal(result.unauthorized_access.length, 0);
		});

		it('(NOMINAL) - Pass in JSON with schemas and table dog defined, insert allowed, expect true', function () {
			let req_json = getRequestJson(TEST_JSON);
			let perms = clone(PERMISSION_BASE);
			perms.dev.tables.dog.insert = true;
			let att_base = ATTRIBUTE_PERMISSION_BASE(TEST_ATTRIBUTES, crud_keys.INSERT, true);
			perms.dev.tables.dog.attribute_permissions = att_base;
			req_json.hdb_user.role.permission = perms;
			let result = op_auth_rewire.verifyPerms(req_json, write.insert.name);
			assert.equal(result, null);
		});

		it('Pass in JSON with schemas and table dog defined, insert allowed, attr insert restriction false. expect false', function () {
			let req_json = getRequestJson(TEST_JSON);
			let perms = clone(PERMISSION_BASE);
			perms.dev.tables.dog.insert = true;
			let att_base = ATTRIBUTE_PERMISSION_BASE([ROLE_PERMISSION_KEY], crud_keys.INSERT, false);
			att_base[0].insert = true;
			perms.dev.tables.dog.attribute_permissions = att_base;
			req_json.hdb_user.role.permission = perms;
			let result = op_auth_rewire.verifyPerms(req_json, write.insert.name);
			assert.equal(result instanceof PermissionResponseObject, true);
			assert.equal(result.invalid_schema_items.length, 2);
			assert.equal(result.unauthorized_access.length, 0);
		});

		it('Pass in get_job request as non-super user. expect true', function () {
			let test_json = {
				operation: 'get_job',
				id: '1234',
				hdb_user: getRequestJson(TEST_JSON).hdb_user,
			};
			assert.equal(op_auth.verifyPerms(test_json, jobs.handleGetJob.name), null);
		});

		it('Pass in search_jobs_by_start_date request as super user. expect true', function () {
			let test_json = {
				operation: 'search_jobs_by_start_date',
				id: '1234',
				hdb_user: getRequestJson(TEST_JSON_SUPER_USER).hdb_user,
			};
			assert.equal(op_auth_rewire.verifyPerms(test_json, jobs.handleGetJobsByStartDate.name), null);
		});

		it('Pass in search_jobs_by_start_date request as non-super user. expect false', function () {
			let test_json = {
				operation: 'search_jobs_by_start_date',
				id: '1234',
				hdb_user: getRequestJson(TEST_JSON).hdb_user,
			};
			let result = op_auth_rewire.verifyPerms(test_json, jobs.handleGetJobsByStartDate.name);
			assert.equal(result.unauthorized_access.length, 1);
			assert.equal(
				result.unauthorized_access[0],
				TEST_OPERATION_AUTH_ERROR.OP_IS_SU_ONLY(jobs.handleGetJobsByStartDate.name)
			);
		});

		it('Pass in get_job request as super user. expect true', function () {
			let test_json = {
				operation: 'get_job',
				id: '1234',
				hdb_user: getRequestJson(TEST_JSON_SUPER_USER).hdb_user,
			};
			assert.equal(op_auth_rewire.verifyPerms(test_json, jobs.handleGetJob.name), null);
		});

		it('Test operation with read & insert required, but user only has insert.  False expected', function () {
			let required_permissions = op_auth_rewire.__get__('requiredPermissions');
			required_permissions.set('test method', new Permission_rw(false, ['insert', 'read']));
			op_auth_rewire.__set__('requiredPermissions', required_permissions);
			let req_json = getRequestJson(TEST_JSON);
			let perms = clone(PERMISSION_BASE);
			perms[TEST_SCHEMA].describe = true;
			perms[TEST_SCHEMA].tables[TEST_TABLE].insert = true;
			req_json.hdb_user.role.permission = perms;
			let result = op_auth_rewire.verifyPerms(req_json, 'test method');
			assert.equal(result.invalid_schema_items.length, 0);
			assert.equal(result.unauthorized_access.length, 1);
			assert.equal(result.unauthorized_access[0] instanceof PermissionTableResponseObject, 1);
			assert.equal(result.unauthorized_access[0].schema, TEST_SCHEMA);
			assert.equal(result.unauthorized_access[0].table, TEST_TABLE);
			assert.equal(result.unauthorized_access[0].required_table_permissions[0], 'read');
		});

		it('Pass in JSON with operation = update and with fully restricted timestamp attr, expect false', function () {
			let req_json = getRequestJson(TEST_JSON);
			req_json.operation = 'update';
			req_json.records[0].__createdtime__ = 'Noooo!';
			let perms = clone(PERMISSION_BASE);
			perms.dev.describe = true;
			perms.dev.tables.dog.describe = true;
			perms.dev.tables.dog.update = true;
			let att_base = ATTRIBUTE_PERMISSION_BASE(TEST_ATTRIBUTES, crud_keys.UPDATE, true);
			perms.dev.tables.dog.attribute_permissions = att_base;
			req_json.hdb_user.role.permission = perms;
			let result = op_auth_rewire.verifyPerms(req_json, req_json.operation);
			assert.equal(
				result.error,
				'This operation is not authorized due to role restrictions and/or invalid database items'
			);
			assert.equal(result.invalid_schema_items.length, 1);
			assert.equal(result.invalid_schema_items[0], "Attribute '__createdtime__' does not exist on 'dev.dog'");
		});

		it('Pass in JSON with operation = update and with non-restricted timestamp value, expect error', function () {
			let req_json = getRequestJson(TEST_JSON);
			req_json.operation = 'update';
			req_json.records[0].__createdtime__ = 'Noooo!';
			let perms = clone(PERMISSION_BASE);
			perms.dev.describe = true;
			perms.dev.tables.dog.describe = true;
			perms.dev.tables.dog.update = true;
			let att_base = ATTRIBUTE_PERMISSION_BASE(TEST_ATTRIBUTES, crud_keys.UPDATE, true);
			att_base.push({ attribute_name: '__createdtime__', read: true });
			perms.dev.tables.dog.attribute_permissions = att_base;
			req_json.hdb_user.role.permission = perms;
			let result;
			try {
				op_auth_rewire.verifyPerms(req_json, req_json.operation);
			} catch (e) {
				result = e;
			}
			assert.equal(result instanceof Error, true);
			assert.equal(result.statusCode, 403);
			assert.equal(
				result.http_resp_msg,
				"Internal timestamp attributes - '__createdtime_' and '__updatedtime__' - cannot be inserted to or updated by HDB users."
			);
		});

		it('(NOMINAL) - Pass in JSON with action = insert, insert allowed, expect true', function () {
			let req_json = getRequestJson(TEST_ACTION_JSON);
			let perms = clone(PERMISSION_BASE);
			perms.dev.tables.dog.insert = true;
			let att_base = ATTRIBUTE_PERMISSION_BASE(TEST_ATTRIBUTES, crud_keys.INSERT, true);
			perms.dev.tables.dog.attribute_permissions = att_base;
			req_json.hdb_user.role.permission = perms;
			let result = op_auth_rewire.verifyPerms(req_json, req_json.operation);
			assert.equal(result, null);
		});

		it('Pass in JSON with action = update, TABLE fully restricted, expect error', function () {
			let req_json = getRequestJson(TEST_ACTION_JSON);
			req_json.action = 'update';
			let perms = clone(PERMISSION_BASE);
			req_json.hdb_user.role.permission = perms;
			let result = op_auth_rewire.verifyPerms(req_json, req_json.operation);
			assert.equal(result.error, TEST_OPERATION_AUTH_ERROR.OP_AUTH_PERMS_ERROR);
			assert.equal(result.invalid_schema_items[0], TEST_SCHEMA_OP_ERROR.SCHEMA_NOT_FOUND(TEST_SCHEMA));
		});

		it('Pass in JSON with action = update, TABLE update restricted, expect error', function () {
			let req_json = getRequestJson(TEST_ACTION_JSON);
			req_json.action = 'update';
			let perms = clone(PERMISSION_BASE);
			perms.dev.describe = true;
			perms.dev.tables.dog.describe = true;
			perms.dev.tables.dog.read = true;
			req_json.hdb_user.role.permission = perms;
			let result = op_auth_rewire.verifyPerms(req_json, req_json.operation);
			assert.equal(result.error, TEST_OPERATION_AUTH_ERROR.OP_AUTH_PERMS_ERROR);
			assert.equal(result.unauthorized_access.length, 1);
			assert.equal(result.unauthorized_access[0].schema, TEST_SCHEMA);
			assert.equal(result.unauthorized_access[0].table, TEST_TABLE);
			assert.equal(result.unauthorized_access[0].required_table_permissions[0], 'update');
			assert.equal(result.unauthorized_access[0].required_table_permissions.length, 1);
			assert.equal(result.unauthorized_access[0].required_attribute_permissions.length, 0);
		});

		it('Test bad method.  False expected', function () {
			const bad_method = 'bad method';
			let req_json = getRequestJson(TEST_JSON);
			let perms = clone(PERMISSION_BASE);
			perms.dev.tables.dog.insert = true;
			req_json.hdb_user.role.permission = perms;
			let test_err;
			try {
				op_auth_rewire.verifyPerms(req_json, bad_method);
			} catch (e) {
				test_err = e;
			}
			assert.equal(test_err.http_resp_msg, TEST_OPERATION_AUTH_ERROR.OP_NOT_FOUND(bad_method));
		});

		it('NOMINAL - Pass in JSON with su, function that requires su.  Expect true.', function () {
			let req_json = getRequestJson(TEST_JSON);
			let perms = clone(PERMISSION_BASE);
			perms.super_user = true;
			perms.dev.tables.dog.insert = true;
			req_json.hdb_user.role.permission = perms;
			let result = op_auth_rewire.verifyPerms(req_json, user.addUser);
			assert.equal(result, null);
		});

		it('Pass in JSON with no su, function that requires su.  Expect false.', function () {
			let req_json = getRequestJson(TEST_JSON);
			let perms = clone(PERMISSION_BASE);
			perms.dev.tables.dog.describe = true;
			perms.dev.tables.dog.insert = true;
			req_json.hdb_user.role.permission = perms;
			let result = op_auth_rewire.verifyPerms(req_json, user.addUser);
			assert.equal(result.unauthorized_access.length, 1);
			assert.equal(result.unauthorized_access[0], TEST_OPERATION_AUTH_ERROR.OP_IS_SU_ONLY(user.addUser.name));
		});

		it('Test error is thrown from trying to drop system schema', () => {
			let req_json = getRequestJson(TEST_JSON);
			req_json.operation = 'drop_schema';
			req_json.schema = 'system';
			let expected_error = test_utils.generateHDBError(
				"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed.",
				403
			);
			test_utils.assertErrorSync(op_auth_rewire.verifyPerms, [req_json, 'dropSchema'], expected_error);
		});

		it('Test error is thrown from trying to drop system table', () => {
			let req_json = getRequestJson(TEST_JSON);
			req_json.operation = 'drop_table';
			req_json.schema = 'system';
			req_json.table = 'hdb_user';
			let expected_error = test_utils.generateHDBError(
				"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed.",
				403
			);
			test_utils.assertErrorSync(op_auth_rewire.verifyPerms, [req_json, 'dropTable'], expected_error);
		});

		it('Test error is thrown from trying to drop system attribute', () => {
			let req_json = getRequestJson(TEST_JSON);
			req_json.operation = 'drop_table';
			req_json.schema = 'system';
			req_json.table = 'hdb_user';
			req_json.attribute = 'username';
			let expected_error = test_utils.generateHDBError(
				"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed.",
				403
			);
			test_utils.assertErrorSync(op_auth_rewire.verifyPerms, [req_json, 'dropAttribute'], expected_error);
		});

		it('Test create_schema with structure_user = true', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP);
			req_json.operation = 'create_schema';
			req_json.schema = 'dev';
			let result = op_auth_rewire.verifyPerms(req_json, schema.createSchema);
			assert.equal(result, null);
		});

		it('Test create_schema with structure_user = ["dev"]', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP2);
			req_json.operation = 'create_schema';
			req_json.schema = 'dev';
			let result = op_auth_rewire.verifyPerms(req_json, schema.createSchema);
			expect(result).to.eql({
				error: 'This operation is not authorized due to role restrictions and/or invalid database items',
				invalid_schema_items: [],
				unauthorized_access: ["Operation 'createSchema' is restricted to 'super_user' roles"],
			});
		});

		it('Test create_table with structure_user = true', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP);
			req_json.operation = 'create_table';
			req_json.schema = 'dev';
			req_json.table = 'dog';
			let result = op_auth_rewire.verifyPerms(req_json, 'createTable');
			assert.equal(result, null);
		});

		it('Test create_table with structure_user = ["dev"]', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP2);
			req_json.operation = 'create_table';
			req_json.schema = 'dev';
			req_json.table = 'dog';
			let result = op_auth_rewire.verifyPerms(req_json, 'createTable');
			assert.equal(result, null);
		});

		it('Test create_table with structure_user = ["dev"], no access to schema "nope"', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP2);
			req_json.operation = 'create_table';
			req_json.schema = 'nope';
			req_json.table = 'dog';
			let result = op_auth_rewire.verifyPerms(req_json, 'createTable');
			assert.equal(result.unauthorized_access.length, 1);
			assert.equal(
				result.unauthorized_access[0],
				"User does not have access to perform 'create_table' against schema 'nope'"
			);
		});

		it('Test create_attribute with structure_user = true', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP);
			req_json.operation = 'create_attribute';
			req_json.schema = 'dev';
			let result = op_auth_rewire.verifyPerms(req_json, schema.createAttribute);
			assert.equal(result, null);
		});

		it('Test create_attribute with structure_user = ["dev"]', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP2);
			req_json.operation = 'create_attribute';
			req_json.schema = 'dev';
			req_json.table = 'dog';
			let result = op_auth_rewire.verifyPerms(req_json, schema.createAttribute);
			assert.equal(result, null);
		});

		it('Test create_attribute with structure_user = ["dev"], no access to schema "nope"', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP2);
			req_json.operation = 'create_attribute';
			req_json.schema = 'nope';
			req_json.table = 'dog';
			let result = op_auth_rewire.verifyPerms(req_json, schema.createAttribute);
			assert.equal(result.unauthorized_access.length, 1);
			assert.equal(
				result.unauthorized_access[0],
				"User does not have access to perform 'create_attribute' against schema 'nope'"
			);
		});

		it('Test drop_attribute with structure_user = true', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP);
			req_json.operation = 'drop_attribute';
			req_json.schema = 'dev';
			let result = op_auth_rewire.verifyPerms(req_json, schema.dropAttribute);
			assert.equal(result, null);
		});

		it('Test drop_attribute with structure_user = ["dev"]', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP2);
			req_json.operation = 'drop_attribute';
			req_json.schema = 'dev';
			req_json.table = 'dog';
			let result = op_auth_rewire.verifyPerms(req_json, schema.dropAttribute);
			assert.equal(result, null);
		});

		it('Test drop_attribute with structure_user = ["dev"], no access to schema "nope"', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP2);
			req_json.operation = 'drop_attribute';
			req_json.schema = 'nope';
			req_json.table = 'dog';
			let result = op_auth_rewire.verifyPerms(req_json, schema.dropAttribute);
			assert.equal(result.unauthorized_access.length, 1);
			assert.equal(
				result.unauthorized_access[0],
				"User does not have access to perform 'drop_attribute' against schema 'nope'"
			);
		});

		it('Test drop_schema with structure_user = true', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP);
			req_json.operation = 'drop_schema';
			req_json.schema = 'dev';
			let result = op_auth_rewire.verifyPerms(req_json, schema.dropSchema);
			assert.equal(result, null);
		});

		it('Test drop_schema with structure_user = ["dev"]', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP2);
			req_json.operation = 'drop_schema';
			req_json.schema = 'dev';
			req_json.table = 'dog';
			let result = op_auth_rewire.verifyPerms(req_json, schema.dropSchema);
			expect(result).to.eql({
				error: 'This operation is not authorized due to role restrictions and/or invalid database items',
				invalid_schema_items: [],
				unauthorized_access: ["Operation 'dropSchema' is restricted to 'super_user' roles"],
			});
		});

		it('Test drop_table with structure_user = true', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP);
			req_json.operation = 'drop_table';
			req_json.schema = 'dev';
			let result = op_auth_rewire.verifyPerms(req_json, schema.dropTable);
			assert.equal(result, null);
		});

		it('Test drop_table with structure_user = ["dev"]', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP2);
			req_json.operation = 'drop_table';
			req_json.schema = 'dev';
			req_json.table = 'dog';
			let result = op_auth_rewire.verifyPerms(req_json, schema.dropTable);
			assert.equal(result, null);
		});

		it('Test drop_table with structure_user = ["dev"], no access to schema "nope"', () => {
			let req_json = getRequestJson(STRUCTURE_USER_OP2);
			req_json.operation = 'drop_table';
			req_json.schema = 'nope';
			req_json.table = 'dog';
			let result = op_auth_rewire.verifyPerms(req_json, schema.dropTable);
			assert.equal(result.unauthorized_access.length, 1);
			assert.equal(
				result.unauthorized_access[0],
				"User does not have access to perform 'drop_table' against schema 'nope'"
			);
		});
	});

	describe(`Test checkAttributePerms`, function () {
		let ROLE_ATTRIBUTE_RESTRICTIONS_UPSERT = _.cloneDeepWith(ROLE_ATTRIBUTE_RESTRICTIONS);
		ROLE_ATTRIBUTE_RESTRICTIONS_UPSERT.get(ROLE_PERMISSION_KEY).update = true;
		ROLE_ATTRIBUTE_RESTRICTIONS_UPSERT.get(HASH_ATTR_KEY).update = true;
		const TEST_ATTRIBUTES_UPSERT = [ROLE_PERMISSION_KEY, HASH_ATTR_KEY];
		const RESTRICTED_ATTRIBUTES_UPSERT = TEST_ATTRIBUTES.filter((attr) => !TEST_ATTRIBUTES_UPSERT.includes(attr));
		const AFFECTED_ATTRS_SET_UPSERT = new Set(TEST_ATTRIBUTES_UPSERT);

		it('Nominal path - Pass in JSON with insert attribute required.  Expect true.', function () {
			let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
			const testPermsResponse = new PermissionResponseObject();
			checkAttributePerms(
				AFFECTED_ATTRIBUTES_SET,
				ROLE_ATTRIBUTE_RESTRICTIONS,
				write.insert.name,
				TEST_TABLE,
				TEST_SCHEMA,
				testPermsResponse
			);
			let result = testPermsResponse.getPermsResponse();
			assert.equal(result, null);
		});

		it('Pass in JSON with insert attribute required, but role does not have insert perm.  Expect false.', function () {
			let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
			let role_att = new Map(ROLE_ATTRIBUTE_RESTRICTIONS);
			role_att.get(ROLE_PERMISSION_KEY).insert = false;
			const testPermsResponse = new PermissionResponseObject();
			checkAttributePerms(
				AFFECTED_ATTRIBUTES_SET,
				role_att,
				write.insert.name,
				TEST_TABLE,
				TEST_SCHEMA,
				testPermsResponse
			);
			let result = testPermsResponse.getPermsResponse();
			assert.equal(result.unauthorized_access.length, 1);

			const unauthed_table = result.unauthorized_access[0];
			assert.equal(unauthed_table instanceof PermissionTableResponseObject, true);
			assert.equal(unauthed_table.schema, TEST_SCHEMA);
			assert.equal(unauthed_table.table, TEST_TABLE);
			assert.equal(unauthed_table.required_attribute_permissions.length, 1);

			const required_attr_perm = unauthed_table.required_attribute_permissions[0];
			assert.equal(required_attr_perm instanceof PermissionAttributeResponseObject, true);
			assert.equal(required_attr_perm.attribute_name, ROLE_PERMISSION_KEY);
			assert.equal(required_attr_perm.attribute_name, ROLE_PERMISSION_KEY);
			assert.equal(required_attr_perm.required_permissions[0], 'insert');
		});

		it('Pass in JSON with action = update, attrs on table have update restricted, expect error', function () {
			let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
			let role_att = _.cloneDeep(ROLE_ATTRIBUTE_RESTRICTIONS);
			const testPermsResponse = new PermissionResponseObject();
			checkAttributePerms(
				AFFECTED_ATTRIBUTES_SET,
				role_att,
				'csvFileLoad',
				TEST_TABLE,
				TEST_SCHEMA,
				testPermsResponse,
				'update'
			);
			let result = testPermsResponse.getPermsResponse();
			assert.equal(result.unauthorized_access.length, 1);

			const unauthed_table = result.unauthorized_access[0];
			assert.equal(unauthed_table instanceof PermissionTableResponseObject, true);
			assert.equal(unauthed_table.schema, TEST_SCHEMA);
			assert.equal(unauthed_table.table, TEST_TABLE);
			assert.equal(unauthed_table.required_attribute_permissions.length, 4);

			unauthed_table.required_attribute_permissions.forEach((attr_obj) => {
				assert.equal(attr_obj instanceof PermissionAttributeResponseObject, true);
				assert.equal(TEST_ATTRIBUTES.includes(attr_obj.attribute_name), true);
				assert.equal(attr_obj.required_permissions[0], 'update');
			});
		});

		it('NOMINAL - Pass in JSON with op = upsert, attrs on table have insert/update perms', function () {
			let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
			let role_att = _.cloneDeep(ROLE_ATTRIBUTE_RESTRICTIONS_UPSERT);
			const testPermsResponse = new PermissionResponseObject();
			checkAttributePerms(
				AFFECTED_ATTRS_SET_UPSERT,
				role_att,
				write.upsert.name,
				TEST_TABLE,
				TEST_SCHEMA,
				testPermsResponse
			);
			let result = testPermsResponse.getPermsResponse();
			assert.equal(result, null);
		});

		it('Pass in JSON with op = upsert, attrs on table have update restricted, expect error', function () {
			let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
			let role_att = _.cloneDeep(ROLE_ATTRIBUTE_RESTRICTIONS_UPSERT);
			const testPermsResponse = new PermissionResponseObject();
			checkAttributePerms(
				AFFECTED_ATTRIBUTES_SET,
				role_att,
				write.upsert.name,
				TEST_TABLE,
				TEST_SCHEMA,
				testPermsResponse
			);
			let result = testPermsResponse.getPermsResponse();
			assert.equal(result.unauthorized_access.length, 1);

			const unauthed_table = result.unauthorized_access[0];
			assert.equal(unauthed_table instanceof PermissionTableResponseObject, true);
			assert.equal(unauthed_table.schema, TEST_SCHEMA);
			assert.equal(unauthed_table.table, TEST_TABLE);
			assert.equal(unauthed_table.required_attribute_permissions.length, 2);

			unauthed_table.required_attribute_permissions.forEach((attr_obj) => {
				assert.equal(attr_obj instanceof PermissionAttributeResponseObject, true);
				assert.equal(RESTRICTED_ATTRIBUTES_UPSERT.includes(attr_obj.attribute_name), true);
				assert.equal(attr_obj.required_permissions[0], 'update');
			});
		});

		it('Pass in JSON with op = upsert, new attrs for table w/ attr restricted, expect error', function () {
			let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
			let role_att = _.cloneDeep(ROLE_ATTRIBUTE_RESTRICTIONS_UPSERT);
			const testPermsResponse = new PermissionResponseObject();
			const test_affected_attrs = _.cloneDeep(AFFECTED_ATTRS_SET_UPSERT);
			const TEST_NEW_ATTR = 'BOOGIE';
			test_affected_attrs.add(TEST_NEW_ATTR);
			checkAttributePerms(test_affected_attrs, role_att, write.upsert.name, TEST_TABLE, TEST_SCHEMA, testPermsResponse);
			let result = testPermsResponse.getPermsResponse();
			assert.equal(result.unauthorized_access.length, 0);
			assert.equal(result.invalid_schema_items.length, 1);
			assert.equal(
				result.invalid_schema_items[0],
				TEST_SCHEMA_OP_ERROR.ATTR_NOT_FOUND(TEST_SCHEMA, TEST_TABLE, TEST_NEW_ATTR)
			);
		});

		it('Pass invalid operation.  Expect false.', function () {
			let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
			assert.throws(function () {
				checkAttributePerms(AFFECTED_ATTRIBUTES_SET, ROLE_ATTRIBUTE_RESTRICTIONS, 'derp');
			}, Error);
		});

		it('Pass invalid json.  Expect false.', function () {
			let checkAttributePerms = op_auth_rewire.__get__('checkAttributePerms');
			assert.throws(function () {
				checkAttributePerms(null, null, write.insert.name);
			}, Error);
		});
	});

	describe(`Test getRecordAttributes`, function () {
		it('Nominal case, valid JSON with attributes.  Expect set with size of 4', function () {
			let getRecordAttributes = op_auth_rewire.__get__('getRecordAttributes');
			let req_json = getRequestJson(TEST_JSON);
			let result = getRecordAttributes(req_json);
			assert.equal(result.size, 4);
		});

		it('pass invalid JSON with attributes.  Expect empty set.', function () {
			let getRecordAttributes = op_auth_rewire.__get__('getRecordAttributes');
			let result = getRecordAttributes(null);
			assert.equal(result.size, 0);
		});

		it('Nominal case pass JSON with no records.  Expect empty set.', function () {
			let getRecordAttributes = op_auth_rewire.__get__('getRecordAttributes');
			let req_json = getRequestJson(TEST_JSON);
			req_json.records = null;
			let result = getRecordAttributes(req_json);
			assert.equal(result.size, 0);
		});

		it('Nominal case, valid JSON for search_by_conditions', function () {
			let expected_attrs = ['id', 'age', 'name', 'adorable', 'location', 'owner_name'];
			let getRecordAttributes = op_auth_rewire.__get__('getRecordAttributes');
			let req_json = clone(TEST_CONDITIONS_JSON);
			let result = getRecordAttributes(req_json);
			assert.equal(result.size, expected_attrs.length);
			expected_attrs.forEach((attr) => {
				assert.ok(result.has(attr));
			});
		});

		it('Nominal case, valid JSON for search_by_value', function () {
			let expected_attrs = ['id', 'age', 'name', 'adorable', 'location'];
			let getRecordAttributes = op_auth_rewire.__get__('getRecordAttributes');
			let req_json = clone(TEST_SEARCH_BY_VAL_JSON);
			let result = getRecordAttributes(req_json);
			assert.equal(result.size, expected_attrs.length);
			expected_attrs.forEach((attr) => {
				assert.ok(result.has(attr));
			});
		});
	});

	describe(`Test getAttributePermissions`, function () {
		it('Nominal case, valid JSON with attributes in the role.', function () {
			let getAttributePermissions = op_auth_rewire.__get__('getAttributePermissions');
			let perms = clone(PERMISSION_BASE);
			perms.dev.tables.dog.insert = true;
			let att_base = ATTRIBUTE_PERMISSION_BASE([ROLE_PERMISSION_KEY], crud_keys.INSERT, false);
			perms.dev.tables.dog.attribute_permissions = att_base;
			let result = getAttributePermissions(perms, 'dev', 'dog');
			assert.equal(result.size, 1);
			assert.equal(result.get('name').attribute_name, 'name');
		});

		it('invalid JSON, Expect zero length Map returned ', function () {
			let getAttributePermissions = op_auth_rewire.__get__('getAttributePermissions');
			let result = getAttributePermissions(null);
			assert.equal(result.size, 0);
		});

		it('JSON with no restrictions in the role. Expect false ', function () {
			let getAttributePermissions = op_auth_rewire.__get__('getAttributePermissions');
			// Leaving this manual definition of the JSON to omit attribute_permissions
			let perms = {
				super_user: false,
				dev: {
					tables: {
						dog: {
							read: false,
							insert: true,
							update: false,
							delete: false,
						},
					},
				},
			};
			let result = getAttributePermissions(perms);
			assert.equal(result.size, 0);
		});

		it('JSON with super user. Expect zero length back ', function () {
			let getAttributePermissions = op_auth_rewire.__get__('getAttributePermissions');
			// Leaving this manual definition of the JSON to omit attribute_permissions
			let perms = {
				super_user: true,
				dev: {
					tables: {
						dog: {
							read: false,
							insert: true,
							update: false,
							delete: false,
						},
					},
				},
			};
			let result = getAttributePermissions(perms);
			assert.equal(result.size, 0);
		});
	});

	describe(`Test hasPermissions`, function () {
		let test_map = new Map();
		test_map.set('dev', ['dog']);

		it('Test invalid parameter', function () {
			let hasPermissions = op_auth_rewire.__get__('hasPermissions');
			assert.throws(function () {
				hasPermissions(null, write.insert.name, new Map());
			}, Error);
		});

		it('Test nominal path, insert required.  Expect true', function () {
			let hasPermissions = op_auth_rewire.__get__('hasPermissions');
			let req_json = getRequestJson(TEST_JSON);
			let perms = {
				super_user: false,
				dev: {
					tables: {
						dog: {
							read: false,
							insert: true,
							update: false,
							delete: false,
							attribute_permissions: [],
						},
					},
				},
			};
			req_json.hdb_user.role.permission = perms;
			const testPermsResponse = new PermissionResponseObject();
			let result = hasPermissions(req_json.hdb_user, write.insert.name, test_map, testPermsResponse);
			assert.equal(result, null);
		});

		it('Test insert required but missing from table perms.  Expect false.', function () {
			let hasPermissions = op_auth_rewire.__get__('hasPermissions');
			let req_json = getRequestJson(TEST_JSON);
			let perms = {
				super_user: false,
				dev: {
					describe: true,
					tables: {
						dog: {
							describe: true,
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: [],
						},
					},
				},
			};
			req_json.hdb_user.role.permission = perms;
			const testPermsResponse = new PermissionResponseObject();
			let result = hasPermissions(req_json.hdb_user, write.insert.name, test_map, testPermsResponse);
			assert.equal(result.unauthorized_access.length, 1);

			const unauthed_table = result.unauthorized_access[0];
			assert.equal(unauthed_table instanceof PermissionTableResponseObject, true);
			assert.equal(unauthed_table.schema, TEST_SCHEMA);
			assert.equal(unauthed_table.table, TEST_TABLE);
			assert.equal(unauthed_table.required_attribute_permissions.length, 0);
		});

		it('NOMINAL - Test upsert op with insert/update perms TRUE', function () {
			let hasPermissions = op_auth_rewire.__get__('hasPermissions');
			let req_json = getRequestJson(TEST_JSON);
			req_json.operation = 'upsert';
			let perms = {
				super_user: false,
				dev: {
					describe: true,
					tables: {
						dog: {
							describe: true,
							read: false,
							insert: true,
							update: true,
							delete: false,
							attribute_permissions: [],
						},
					},
				},
			};
			req_json.hdb_user.role.permission = perms;
			const testPermsResponse = new PermissionResponseObject();
			let result = hasPermissions(req_json.hdb_user, write.upsert.name, test_map, testPermsResponse);
			assert.equal(result, null);
		});

		it('Test upsert op with insert perms false - expect error', function () {
			let hasPermissions = op_auth_rewire.__get__('hasPermissions');
			let req_json = getRequestJson(TEST_JSON);
			req_json.operation = 'upsert';
			let perms = {
				super_user: false,
				dev: {
					describe: true,
					tables: {
						dog: {
							describe: true,
							read: false,
							insert: false,
							update: true,
							delete: false,
							attribute_permissions: [],
						},
					},
				},
			};
			req_json.hdb_user.role.permission = perms;
			const testPermsResponse = new PermissionResponseObject();
			let result = hasPermissions(req_json.hdb_user, write.upsert.name, test_map, testPermsResponse);
			assert.equal(result.unauthorized_access.length, 1);

			const unauthed_table = result.unauthorized_access[0];
			assert.equal(unauthed_table instanceof PermissionTableResponseObject, true);
			assert.equal(unauthed_table.schema, TEST_SCHEMA);
			assert.equal(unauthed_table.required_table_permissions[0], 'insert');
			assert.equal(unauthed_table.table, TEST_TABLE);
			assert.equal(unauthed_table.required_attribute_permissions.length, 0);
		});

		it('Test upsert op with update perms false - expect error', function () {
			let hasPermissions = op_auth_rewire.__get__('hasPermissions');
			let req_json = getRequestJson(TEST_JSON);
			req_json.operation = 'upsert';
			let perms = {
				super_user: false,
				dev: {
					describe: true,
					tables: {
						dog: {
							describe: true,
							read: false,
							insert: true,
							update: false,
							delete: false,
							attribute_permissions: [],
						},
					},
				},
			};
			req_json.hdb_user.role.permission = perms;
			const testPermsResponse = new PermissionResponseObject();
			let result = hasPermissions(req_json.hdb_user, write.upsert.name, test_map, testPermsResponse);
			assert.equal(result.unauthorized_access.length, 1);

			const unauthed_table = result.unauthorized_access[0];
			assert.equal(unauthed_table instanceof PermissionTableResponseObject, true);
			assert.equal(unauthed_table.schema, TEST_SCHEMA);
			assert.equal(unauthed_table.required_table_permissions[0], 'update');
			assert.equal(unauthed_table.table, TEST_TABLE);
			assert.equal(unauthed_table.required_attribute_permissions.length, 0);
		});

		it('Test upsert op with insert/update perms false - expect error', function () {
			let hasPermissions = op_auth_rewire.__get__('hasPermissions');
			let req_json = getRequestJson(TEST_JSON);
			req_json.operation = 'upsert';
			let perms = {
				super_user: false,
				dev: {
					describe: true,
					tables: {
						dog: {
							describe: true,
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: [],
						},
					},
				},
			};
			req_json.hdb_user.role.permission = perms;
			const testPermsResponse = new PermissionResponseObject();
			let result = hasPermissions(req_json.hdb_user, write.upsert.name, test_map, testPermsResponse);
			assert.equal(result.unauthorized_access.length, 1);

			const unauthed_table = result.unauthorized_access[0];
			assert.equal(unauthed_table instanceof PermissionTableResponseObject, true);
			assert.equal(unauthed_table.schema, TEST_SCHEMA);
			assert.deepEqual(unauthed_table.required_table_permissions, ['insert', 'update']);
			assert.equal(unauthed_table.table, TEST_TABLE);
			assert.equal(unauthed_table.required_attribute_permissions.length, 0);
		});
	});
});
