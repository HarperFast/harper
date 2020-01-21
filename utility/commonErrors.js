"use strict";

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
    RECORDS_MUST_BE_ARRAY: new Error('records must be an array')
};

module.exports = {
    LMDB_ERRORS_ENUM
};