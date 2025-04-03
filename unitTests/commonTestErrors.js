'use strict';

const lmdb_terms = require('../utility/lmdb/terms');
const { isHDBError, hdbErrors } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdbErrors;
/**
 * the purpose of this is to hold the expected errors to check from our functions being tested
 */

const LMDB_ERRORS_ENUM = {
	BASE_PATH_REQUIRED: new Error('base_path is required'),
	DESTINATION_PATH_REQUIRED: new Error('destination_path is required'),
	ENV_NAME_REQUIRED: new Error('env_name is required'),
	INVALID_BASE_PATH: new Error('invalid base_path'),
	INVALID_ENVIRONMENT: new Error('invalid environment'),
	INVALID_DESTINATION_PATH: new Error('invalid destination_path'),
	ENV_REQUIRED: new Error('env is required'),
	DBI_NAME_REQUIRED: new Error('dbi_name is required'),
	DBI_DOES_NOT_EXIST: new Error('dbi does not exist'),
	HASH_ATTRIBUTE_REQUIRED: new Error('hash_attribute is required'),
	ID_REQUIRED: new Error('id is required'),
	IDS_REQUIRED: new Error('ids is required'),
	IDS_MUST_BE_ITERABLE: new Error('ids must be iterable'),
	FETCH_ATTRIBUTES_REQUIRED: new Error('fetch_attributes is required'),
	FETCH_ATTRIBUTES_MUST_BE_ARRAY: new Error('fetch_attributes must be an array'),
	ATTRIBUTE_REQUIRED: new Error('attribute is required'),
	SEARCH_VALUE_REQUIRED: new Error('search_value is required'),
	WRITE_ATTRIBUTES_REQUIRED: new Error('write_attributes is required'),
	WRITE_ATTRIBUTES_MUST_BE_ARRAY: new Error('write_attributes must be an array'),
	RECORDS_REQUIRED: new Error('records is required'),
	RECORDS_MUST_BE_ARRAY: new Error('records must be an array'),
	CANNOT_CREATE_INTERNAL_DBIS_NAME: new Error(`cannot create a dbi named ${lmdb_terms.INTERNAL_DBIS_NAME}`),
	CANNOT_DROP_INTERNAL_DBIS_NAME: new Error(`cannot drop a dbi named ${lmdb_terms.INTERNAL_DBIS_NAME}`),
	START_VALUE_REQUIRED: new Error('start_value is required'),
	END_VALUE_REQUIRED: new Error('end_value is required'),
	CANNOT_COMPARE_STRING_TO_NUMERIC_KEYS: new Error('cannot compare a string to numeric keys'),
	END_VALUE_MUST_BE_GREATER_THAN_START_VALUE: new Error('end_value must be greater than or equal to start_value'),
	UNKNOWN_SEARCH_TYPE: new Error('unknown search type'),
	CANNOT_DROP_TABLE_HASH_ATTRIBUTE: new Error("cannot drop a table's hash attribute"),
};

const TEST_WRITE_OPS_ERROR_MSGS = {
	ATTR_NAME_LENGTH_ERR: (attr_name) =>
		`transaction aborted due to attribute name ${attr_name} being too long. Attribute names cannot be longer than 250 bytes.`,
	ATTR_NAME_NULLISH_ERR:
		'transaction aborted due to record(s) with an attribute name that is null, undefined or empty string',
	HASH_VAL_LENGTH_ERR:
		'transaction aborted due to record(s) with a hash value that exceeds 250 bytes, check log for more info',
	INVALID_FORWARD_SLASH_IN_HASH_ERR:
		'transaction aborted due to record(s) with a hash value that contains a forward slash, check log for more info',
	RECORD_MISSING_HASH_ERR: 'transaction aborted due to record(s) with no hash value, check log for more info',
};

const TEST_BULK_LOAD_ERROR_MSGS = {
	DEFAULT_BULK_LOAD_ERR: 'There was an error during your bulk load into HarperDB.',
	DOWNLOAD_FILE_ERR: (file_name) => `There was an error downloading '${file_name}'.`,
	INSERT_JSON_ERR: 'There was an error inserting the downloaded JSON data.',
	INSERT_CSV_ERR: 'There was an error inserting the downloaded CSV data.',
	INVALID_ACTION_PARAM_ERR: (action) => `Bulk load operation failed - ${action} is not a valid 'action' parameter`,
	INVALID_FILE_EXT_ERR: (json) => `Error selecting correct parser - valid file type not found in json - ${json}`,
	MAX_FILE_SIZE_ERR: (file_size, max_size) =>
		`File size is ${file_size} bytes, which exceeded the maximum size allowed of: ${max_size} bytes`,
	PAPA_PARSE_ERR: 'There was an error parsing the downloaded CSV data.',
	S3_DOWNLOAD_ERR: (file_name) => `There was an error downloading '${file_name}' from AWS.`,
	WRITE_TEMP_FILE_ERR: `Error writing temporary file to storage`,
};

const TEST_OPERATION_AUTH_ERROR = {
	DEFAULT_INVALID_REQUEST: 'Invalid request',
	OP_AUTH_PERMS_ERROR: 'This operation is not authorized due to role restrictions and/or invalid database items',
	OP_IS_SU_ONLY: (op) => `Operation '${op}' is restricted to 'super_user' roles`,
	OP_NOT_FOUND: (op) => `Operation '${op}' not found`,
	UNKNOWN_OP_AUTH_ERROR: (op, schema, table) => `There was an error authorizing ${op} op on table '${schema}.${table}'`,
	USER_HAS_NO_PERMS: (user) => `User ${user} has no role or permissions.  Please assign the user a valid role.`,
};

const TEST_SCHEMA_OP_ERROR = {
	ATTR_NOT_FOUND: (schema, table, attr) => `Attribute '${attr}' does not exist on '${schema}.${table}'`,
	DESCRIBE_ALL_ERR: 'There was an error during describeAll.  Please check the logs and try again.',
	INVALID_TABLE_ERR: (table_result) => `Invalid table ${JSON.stringify(table_result)}`,
	SCHEMA_NOT_FOUND: (schema) => `database '${schema}' does not exist`,
	SCHEMA_REQUIRED_ERR: 'schema is required',
	TABLE_NOT_FOUND: (schema, table) => `Table '${schema}.${table}' does not exist`,
	TABLE_REQUIRED_ERR: 'table is required',
};

const TEST_ROLE_PERMS_ERROR = {
	ATTR_PERM_MISSING: (perm, attr_name) => `${perm.toUpperCase()} attribute permission missing for '${attr_name}'`,
	ATTR_PERM_MISSING_NAME: "Permission object in 'attribute_permission' missing an 'attribute_name'",
	ATTR_PERM_NOT_BOOLEAN: (perm, attr_name) =>
		`${perm.toUpperCase()} attribute permission for '${attr_name}' must be a boolean`,
	ATTR_PERMS_ARRAY_MISSING: "Missing 'attribute_permissions' array",
	ATTR_PERMS_NOT_ARRAY: "Value for 'attribute_permissions' must be an array",
	INVALID_ATTRIBUTE_IN_PERMS: (attr_name) => `Invalid attribute '${attr_name}' in 'attribute_permissions'`,
	INVALID_PERM_KEY: (table_key) => `Invalid table permission key value '${table_key}'`,
	INVALID_ATTR_PERM_KEY: (attr_perm_key) => `Invalid attribute permission key value '${attr_perm_key}'`,
	INVALID_ROLE_JSON_KEYS: (invalid_keys) =>
		`Invalid ${invalid_keys.length > 1 ? 'keys' : 'key'} in JSON body - '${invalid_keys.join("', '")}'`,
	MISMATCHED_TABLE_ATTR_PERMS: (schema_table) =>
		`You have a conflict with TABLE permissions for '${schema_table}' being false and ATTRIBUTE permissions being true`,
	OUTDATED_PERMS_TRANSLATION_ERROR:
		"This instance was recently upgraded and uses our new role permissions structure. Please login to this instance in HarperDB Studio, go to 'Roles', and click 'Update Role Permission' for all standard roles to migrate them to the new structure.",
	ROLE_ALREADY_EXISTS: (role_name) => `A role with name '${role_name}' already exists`,
	ROLE_NOT_FOUND: 'Role not found',
	ROLE_PERMS_ERROR: 'Errors in the role permissions JSON provided',
	SCHEMA_PERM_ERROR: (schema_name) => `Your role does not have permission to view schema metadata for '${schema_name}'`,
	SCHEMA_TABLE_PERM_ERROR: (schema_name, table_name) =>
		`Your role does not have permission to view schema.table metadata for '${schema_name}.${table_name}'`,
	SU_ROLE_MISSING_ERROR: "Missing 'super_user' key/value in permission set",
	SU_CU_ROLE_BOOLEAN_ERROR: (role) => `Value for '${role}' permission must be a boolean`,
	SU_CU_ROLE_NO_PERMS_ALLOWED: (role) => `Roles with '${role}' set to true cannot have other permissions set.`,
	SU_CU_ROLE_COMBINED_ERROR:
		"Roles cannot have both 'super_user' and 'cluster_user' values included in their permissions set.",
	TABLE_PERM_MISSING: (perm) => `Missing table ${perm.toUpperCase()} permission`,
	TABLE_PERM_NOT_BOOLEAN: (perm) => `Table ${perm.toUpperCase()} permission must be a boolean`,
	STRUCTURE_USER_ROLE_TYPE_ERROR: (role) => `Value for '${role}' permission must be a boolean or Array`,
};

const CHECK_LOGS_WRAPPER = (err) => `${err} Check logs and try again.`;
const TEST_DEFAULT_ERROR_MSGS = {
	500: CHECK_LOGS_WRAPPER('There was an error processing your request.'),
	400: 'Invalid request',
};

const TEST_DEFAULT_ERROR_RESP = TEST_DEFAULT_ERROR_MSGS[HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR];

const TEST_USER_ERROR_MSGS = {
	ALTER_USER_DUP_ROLES: (role) =>
		`Update failed.  There are duplicates for the '${role}' role which is not allowed. Update your roles and try again.`,
	ALTER_USER_ROLE_NOT_FOUND: (role) => `Update failed.  Requested '${role}' role not found.`,
	DUP_ROLES_FOUND: (role) =>
		`Multiple ${role} roles found.  Roles must have unique 'role' value. Please update and try again.`,
	ROLE_NAME_NOT_FOUND: (role) => `${role} role not found`,
};

module.exports = {
	CHECK_LOGS_WRAPPER,
	LMDB_ERRORS_ENUM,
	TEST_WRITE_OPS_ERROR_MSGS,
	TEST_BULK_LOAD_ERROR_MSGS,
	TEST_DEFAULT_ERROR_RESP,
	TEST_ROLE_PERMS_ERROR,
	TEST_OPERATION_AUTH_ERROR,
	TEST_SCHEMA_OP_ERROR,
	HTTP_STATUS_CODES,
	TEST_USER_ERROR_MSGS,
	isHDBError,
};
