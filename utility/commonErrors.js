"use strict";

const lmdb_terms = require('./lmdb/terms');

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
    UKNOWN_SEARCH_TYPE: 'unknown search type',
    CANNOT_DROP_TABLE_HASH_ATTRIBUTE: 'cannot drop a table\'s hash attribute'
};

module.exports = {
    LMDB_ERRORS_ENUM
};