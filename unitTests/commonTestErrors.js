"use strict";

const lmdb_terms = require('../utility/lmdb/terms');
/**
 * the purpose of this is to hold the expected errors to check from our functions being tested
 */

const LMDB_ERRORS_ENUM = {
    BASE_PATH_REQUIRED: new Error('base_path is required'),
    ENV_NAME_REQUIRED: new Error('env_name is required'),
    INVALID_BASE_PATH: new Error('invalid base_path'),
    INVALID_ENVIRONMENT: new Error('invalid environment'),
    ENV_REQUIRED: new Error('env is required'),
    DBI_NAME_REQUIRED: new Error('dbi_name is required'),
    DBI_DOES_NOT_EXIST: new Error('dbi does not exist'),
    HASH_ATTRIBUTE_REQUIRED: new Error('hash_attribute is required'),
    ID_REQUIRED: new Error('id is required'),
    IDS_REQUIRED: new Error('ids is required'),
    IDS_MUST_BE_ARRAY: new Error('ids must be an array'),
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
    END_VALUE_MUST_BE_GREATER_THAN_START_VALUE: new Error('end_value must be greater than start_value'),
    UNKNOWN_SEARCH_TYPE: new Error('unknown search type'),
    CANNOT_DROP_TABLE_HASH_ATTRIBUTE: new Error('cannot drop a table\'s hash attribute')
};

const COMMON_ERROR_MSGS = {
    SCHEMA_REQUIRED: 'schema is required',
    TABLE_REQUIRED: 'table is required'
};

module.exports = {
    LMDB_ERRORS_ENUM,
    COMMON_ERROR_MSGS
};
