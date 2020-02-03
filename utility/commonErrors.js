"use strict";

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
    CANNOT_CREATE_INTERNAL_DBIS_NAME: 'cannot create a dbi named __dbis__',
    CANNOT_DROP_INTERNAL_DBIS_NAME: 'cannot drop a dbi named __dbis__'
};

module.exports = {
    LMDB_ERRORS_ENUM
};