"use strict";

const lmdb_terms = require('../lmdb/terms');

// A subset of HTTP error codes that we may use in code.
const HTTP_STATUS_CODES = {
    CONTINUE: 100,
    OK: 200,
    CREATED: 201,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    REQUEST_TIMEOUT: 408,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
    NOT_IMPLEMENTED: 501,
    BAD_GATEWAY: 502,
    SERVICE_UNAVAILABLE: 503,
    GATEWAY_TIMEOUT: 504,
    HTTP_VERSION_NOT_SUPPORTED: 505,
    INSUFFICIENT_STORAGE: 507,
    NETWORK_AUTHENTICATION_REQUIRED: 511
};

const DEFAULT_ERROR_MSGS = {
    500: 'There was an error processing your request.  Please check the logs and try again.'
};
const DEFAULT_ERROR_RESP = DEFAULT_ERROR_MSGS[HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR];

const SCHEMA_OP_ERROR_MSGS = {
    DESCRIBE_ALL_ERR: "There was an error during describeAll.  Please check the logs and try again.",
    SCHEMA_NOT_FOUND: (schema) => `Schema '${schema}' does not exist`,
    TABLE_NOT_FOUND: (schema, table) => `Table '${schema}.${table}' does not exist`,
    INVALID_TABLE_ERR: (table_result) => `Invalid table ${JSON.stringify(table_result)}`
};

const ROLE_PERMS_ERROR_MSGS = {
    ATTR_PERM_MISSING: (perm, attr_name) => `${perm.toUpperCase()} attribute permission missing for '${attr_name}'`,
    ATTR_PERM_MISSING_NAME: "Permission object in 'attribute_permission' missing an 'attribute_name'",
    ATTR_PERM_NOT_BOOLEAN: (perm, attr_name) => `${perm.toUpperCase()} attribute permission for '${attr_name}' must be a boolean`,
    ATTR_PERMS_ARRAY_MISSING: "Missing 'attribute_permissions' array",
    ATTR_PERMS_NOT_ARRAY: "Value for 'attribute_permissions' must be an array",
    INVALID_ATTRIBUTE_IN_PERMS: (attr_name) => `Invalid attribute ${attr_name} in 'attribute_permissions'`,
    INVALID_PERM_KEY: (table_key) => `Invalid table permission key value '${table_key}'`,
    INVALID_ATTR_PERM_KEY: (attr_perm_key) => `Invalid attribute permission key value '${attr_perm_key}'`,
    MISMATCHED_TABLE_ATTR_PERMS: (schema_table) => `You have a conflict with TABLE permissions for '${schema_table}' being false and ATTRIBUTE permissions being true`,
    ROLE_PERMS_ERROR: 'Errors in the role permissions JSON provided',
    SCHEMA_PERM_ERROR: (schema_name) => `Your role does not have permission to view schema metadata for '${schema_name}'`,
    SCHEMA_TABLE_PERM_ERROR: (schema_name, table_name) => `Your role does not have permission to view schema.table metadata for '${schema_name}.${table_name}'`,
    SU_ROLE_MISSING_ERROR: "Missing 'super_user' key/value in permission set",
    SU_CU_ROLE_BOOLEAN_ERROR: (role) => `Value for '${role}' permission must be a boolean`,
    SU_CU_ROLE_NO_PERMS_ALLOWED: (role) => `Roles with '${role}' set to true cannot have other permissions set.`,
    SU_CU_ROLE_COMBINED_ERROR: "Roles cannot have both 'super_user' and 'cluster_user' values included in their permissions set.",
    TABLE_PERM_MISSING: (perm) => `Missing table ${perm.toUpperCase()} permission`,
    TABLE_PERM_NOT_BOOLEAN: (perm) => `Table ${perm.toUpperCase()} permission must be a boolean`
};

const SQL_ERROR_MSGS = {
    OUTER_JOIN_TRANSLATION_ERROR: "There was an error translating the final SQL outer join data."
};

//TODO - move this enum to be exported as a part of COMMON_ERROR_MSGS
//NOTE: Any changes made to these errors must also be made to unitTests/commonTestErrors.js otherwise the unit tests will fail
const LMDB_ERRORS_ENUM = {
    BASE_PATH_REQUIRED: 'base_path is required',
    ENV_NAME_REQUIRED: 'env_name is required',
    INVALID_BASE_PATH: 'invalid base_path',
    INVALID_ENVIRONMENT: 'invalid environment',
    ENV_REQUIRED: 'env is required',
    DBI_NAME_REQUIRED: 'dbi_name is required',
    DBI_DOES_NOT_EXIST: 'dbi does not exist',
    HASH_ATTRIBUTE_REQUIRED: 'hash_attribute is required',
    ID_REQUIRED: 'id is required',
    IDS_REQUIRED: 'ids is required',
    IDS_MUST_BE_ARRAY: 'ids must be an array',
    FETCH_ATTRIBUTES_REQUIRED: 'fetch_attributes is required',
    FETCH_ATTRIBUTES_MUST_BE_ARRAY: 'fetch_attributes must be an array',
    ATTRIBUTE_REQUIRED: 'attribute is required',
    SEARCH_VALUE_REQUIRED: 'search_value is required',
    WRITE_ATTRIBUTES_REQUIRED: 'write_attributes is required',
    WRITE_ATTRIBUTES_MUST_BE_ARRAY: 'write_attributes must be an array',
    RECORDS_REQUIRED: 'records is required',
    RECORDS_MUST_BE_ARRAY: 'records must be an array',
    CANNOT_CREATE_INTERNAL_DBIS_NAME: `cannot create a dbi named ${lmdb_terms.INTERNAL_DBIS_NAME}`,
    CANNOT_DROP_INTERNAL_DBIS_NAME: `cannot drop a dbi named ${lmdb_terms.INTERNAL_DBIS_NAME}`,
    START_VALUE_REQUIRED: 'start_value is required',
    END_VALUE_REQUIRED: 'end_value is required',
    CANNOT_COMPARE_STRING_TO_NUMERIC_KEYS: 'cannot compare a string to numeric keys',
    END_VALUE_MUST_BE_GREATER_THAN_START_VALUE: 'end_value must be greater than start_value',
    UNKNOWN_SEARCH_TYPE: 'unknown search type',
    CANNOT_DROP_TABLE_HASH_ATTRIBUTE: 'cannot drop a table\'s hash attribute'
};

// All error messages should be added to the COMMON_ERROR_MSGS ENUM for export - this helps to organize all error messages
//into a single export while still allowing us to group them here in a more readable/searchable way
const COMMON_ERROR_MSGS = {
    ...ROLE_PERMS_ERROR_MSGS,
    ...SQL_ERROR_MSGS,
    ...SCHEMA_OP_ERROR_MSGS,
    SCHEMA_REQUIRED: 'schema is required',
    TABLE_REQUIRED: 'table is required'
};

module.exports = {
    COMMON_ERROR_MSGS,
    DEFAULT_ERROR_MSGS,
    DEFAULT_ERROR_RESP,
    HTTP_STATUS_CODES,
    LMDB_ERRORS_ENUM
};
