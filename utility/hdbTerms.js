'use strict';

/**
 * This module should contain common variables/values that will be used across the project.  This should avoid
 * duplicate values making refactoring a little easier.
 */

 // Name of the HDB process
const HDB_PROC_NAME = 'hdb_express.js';

// Name of the System schema
const SYSTEM_SCHEMA_NAME = 'system';

// Role table name
const ROLE_TABLE_NAME = 'hdb_role';

// Job table name
const JOB_TABLE_NAME = 'hdb_job';

// Describes all available job types
const JOB_TYPE_ENUM = {
    csv_file_load: 'csv_file_load',
    empty_trash: 'empty_trash',
    csv_url_load: 'csv_url_load',
    csv_data_load: 'csv_data_load',
    export_to_s3: 'export_to_s3',
    export_local: 'export_local',
	delete_files_before: 'delete_files_before'
};

// Describes the available statuses for jobs
const JOB_STATUS_ENUM = {
	CREATED: 'CREATED',
	IN_PROGRESS: 'IN_PROGRESS',
	COMPLETE: 'COMPLETE',
	ERROR: 'ERROR'
};

// A subset of HTTP error codes that we may use in code.
const HTTP_STATUS_CODES = {
    BAD_GATEWAY: 502,
    BAD_REQUEST: 400,
    CONTINUE: 100,
    CREATED: 201,
    FORBIDDEN: 403,
    GATEWAY_TIMEOUT: 504,
    HTTP_VERSION_NOT_SUPPORTED: 505,
    INSUFFICIENT_STORAGE: 507,
    INTERNAL_SERVER_ERROR: 500,
    METHOD_NOT_ALLOWED: 405,
    NETWORK_AUTHENTICATION_REQUIRED: 511,
    NOT_FOUND: 404,
    OK: 200,
    REQUEST_TIMEOUT: 408,
    SERVICE_UNAVAILABLE: 503,
    UNAUTHORIZED: 401,
    NOT_IMPLEMENTED: 501
};

// Operations
const OPERATIONS_ENUM = {
    UPDATE: 'update'
};

//describes the Geo Conversion types
const GEO_CONVERSION_ENUM = {
    point: 'point',
    lineString: 'lineString',
    multiLineString: 'multiLineString',
    multiPoint: 'multiPoint',
    multiPolygon: 'multiPolygon',
    polygon: 'polygon'
};

const HDB_SETTINGS_NAMES = {
    PROJECT_DIR: 'PROJECT_DIR',
    HDB_ROOT: 'HDB_ROOT',
    HTTP_PORT: 'HTTP_PORT',
    HTTPS_PORT: 'HTTPS_PORT',
    CERTIFICATE: 'CERTIFICATE',
    PRIVATE_KEY: 'PRIVATE_KEY',
    HTTPS_ON: 'HTTPS_ON',
    HTTP_ON: 'HTTP_ON',
    CORS_ON: 'CORS_ON',
    CORS_WHITELIST: 'CORS_WHITELIST',
    SERVER_TIMEOUT_MS: 'SERVER_TIMEOUT_MS',
    LOG_LEVEL: 'LOG_LEVEL',
    LOGGER: 'LOG_LEVEL',
    LOG_PATH: 'LOG_PATH',
    NODE_ENV: 'NODE_ENV'
};

module.exports = {
    HDB_PROC_NAME,
    SYSTEM_SCHEMA_NAME,
    ROLE_TABLE_NAME,
    JOB_TABLE_NAME,
    JOB_TYPE_ENUM,
    JOB_STATUS_ENUM,
    OPERATIONS_ENUM,
    HTTP_STATUS_CODES,
    GEO_CONVERSION_ENUM,
    HDB_SETTINGS_NAMES
};

