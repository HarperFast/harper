'use strict';

/**
 * This module should contain common variables/values that will be used across the project.  This should avoid
 * duplicate values making refactoring a little easier.
 */

 // Name of the HDB process
const HDB_PROC_NAME = 'hdb_express.js';

const PERIOD_REGEX = /^\.$/;

const DOUBLE_PERIOD_REGEX = /^\.\.$/;

const UNICODE_PERIOD = 'U+002E';

const FORWARD_SLASH_REGEX = /\//g;

const UNICODE_FORWARD_SLASH = 'U+002F';

const ESCAPED_FORWARD_SLASH_REGEX = /U\+002F/g;

const ESCAPED_PERIOD_REGEX = /^U\+002E$/;

const ESCAPED_DOUBLE_PERIOD_REGEX = /^U\+002EU\+002E$/;

// Name of the System schema
const SYSTEM_SCHEMA_NAME = 'system';

//this variable defines operations that should only run locally and not pass over clustering to another node(s)
const LOCAL_HARPERDB_OPERATIONS = ['describe_all', 'describe_table', 'describe_schema', 'read_log', 'add_node', 'list_users', 'list_roles', 'user_info', 'sql', 'get_job', 'search_jobs_by_start_date', 'delete_files_before', 'export_local', 'export_to_s3'];

const SYSTEM_TABLE_NAMES = {
    JOB_TABLE_NAME : 'hdb_job',
    NODE_TABLE_NAME :'hdb_nodes',
    ATTRIBUTE_TABLE_NAME : 'hdb_attribute',
    LICENSE_TABLE_NAME: 'hdb_license',
    QUEUE_TABLE_NAME: 'hdb_queue',
    ROLE_TABLE_NAME: 'hdb_role',
    SCHEMA_TABLE_NAME: 'hdb_schema',
    TABLE_TABLE_NAME: 'hdb_table',
    USER_TABLE_NAME: 'hdb_user'
}

// Registration key file name
const REG_KEY_FILE_NAME = '060493.ks';

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
    INSERT: 'insert',
    UPDATE: 'update',
    SEARCH_BY_HASH: 'search_by_hash',
    SEARCH_BY_VALUE: 'search_by_value',
    SEARCH: 'search',
    SQL: 'sql',
    CSV_DATA_LOAD: 'csv_data_load',
    CSV_FILE_LOAD: 'csv_file_load',
    CSV_URL_LOAD: 'csv_url_load',
    CREATE_SCHEMA: 'create_schema',
    CREATE_TABLE: 'create_table',
    CREATE_ATTRIBUTE: 'create_attribute',
    DROP_SCHEMA: 'drop_schema',
    DROP_TABLE: 'drop_table',
    DESCRIBE_SCHEMA: 'describe_schema',
    DESCRIBE_TABLE: 'describe_table',
    DESCRIBE_ALL: 'describe_all',
    DELETE: 'delete',
    ADD_USER: 'add_user',
    ALTER_USER: 'alter_user',
    DROP_USER: 'drop_user',
    LIST_USERS: 'list_users',
    LIST_ROLES: 'list_roles',
    ADD_ROLE: 'add_role',
    ALTER_ROLE: 'alter_role',
    DROP_ROLE: 'drop_role',
    USER_INFO: 'user_info',
    READ_LOG: 'read_log',
    ADD_NODE: 'add_node',
    EXPORT_TO_S3: 'export_to_s3',
    DELETE_FILES_BEFORE: 'delete_files_before',
    EXPORT_LOCAL: 'export_local',
    SEARCH_JOBS_BY_START_DATE: 'search_jobs_by_start_date',
    GET_JOB: 'get_job',
    DELETE_JOB: 'delete_job',
    UPDATE_JOB: 'update_job',
    GET_FINGERPRINT: 'get_fingerprint',
    SET_LICENSE: 'set_license',
    CONFIGURE_CLUSTER: 'configure_cluster'
};

const SERVICE_ACTIONS_ENUM = {
    RUN:'run',
    INSTALL:'install',
    REGISTER:'register',
    STOP:'stop',
    RESTART:'restart',
    VERSION: 'version',
    UPGRADE:'upgrade',
    UPGRADE_EXTERN: 'upgrade_external'
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
    PROJECT_DIR_KEY: 'PROJECT_DIR',
    HDB_ROOT_KEY: 'HDB_ROOT',
    HTTP_PORT_KEY: 'HTTP_PORT',
    HTTP_SECURE_PORT_KEY: 'HTTPS_PORT',
    CERT_KEY: 'CERTIFICATE',
    PRIVATE_KEY_KEY: 'PRIVATE_KEY',
    HTTP_SECURE_ENABLED_KEY: 'HTTPS_ON',
    HTTP_ENABLED_KEY: 'HTTP_ON',
    CORS_ENABLED_KEY: 'CORS_ON',
    CORS_WHITELIST_KEY: 'CORS_WHITELIST',
    PROPS_SERVER_TIMEOUT_KEY: 'SERVER_TIMEOUT_MS',
    LOG_LEVEL_KEY: 'LOG_LEVEL',
    LOGGER_KEY: 'LOGGER',
    LOG_PATH_KEY: 'LOG_PATH',
    PROPS_ENV_KEY: 'NODE_ENV',
    SETTINGS_PATH_KEY: 'settings_path',
    CLUSTERING_PORT_KEY: 'CLUSTERING_PORT',
    CLUSTERING_NODE_NAME_KEY: 'NODE_NAME',
    CLUSTERING_ENABLED_KEY: 'CLUSTERING'
};

// Default values for the Settings, some do not have a default.
const HDB_SETTINGS_DEFAULT_VALUES = {
    HTTP_PORT: '9925',
    HTTPS_PORT: '31283',
    HTTPS_ON: 'true',
    HTTP_ON: 'false',
    CORS_ON: 'true',
    CORS_WHITELIST: '',
    SERVER_TIMEOUT_MS: '120000',
    LOG_LEVEL: 'error',
    LOGGER: '1',
    LOG_PATH: './harper_log.log',
    NODE_ENV: 'production',
    CLUSTERING_PORT: '5545',
    CLUSTERING: 'false'
};

// Describes all available job types
const JOB_TYPE_ENUM = {
    csv_file_load: 'csv_file_load',
    empty_trash: 'empty_trash',
    csv_url_load: OPERATIONS_ENUM.CSV_URL_LOAD,
    csv_data_load: OPERATIONS_ENUM.CSV_DATA_LOAD,
    export_to_s3: 'export_to_s3',
    export_local: 'export_local',
    delete_files_before: 'delete_files_before'
};

module.exports = {
    HDB_PROC_NAME,
    SYSTEM_SCHEMA_NAME,
    JOB_TYPE_ENUM,
    JOB_STATUS_ENUM,
    SYSTEM_TABLE_NAMES,
    OPERATIONS_ENUM,
    HTTP_STATUS_CODES,
    GEO_CONVERSION_ENUM,
    HDB_SETTINGS_NAMES,
    HDB_SETTINGS_DEFAULT_VALUES,
    SERVICE_ACTIONS_ENUM,
    PERIOD_REGEX,
    DOUBLE_PERIOD_REGEX,
    UNICODE_PERIOD,
    FORWARD_SLASH_REGEX,
    UNICODE_FORWARD_SLASH,
    ESCAPED_FORWARD_SLASH_REGEX,
    ESCAPED_PERIOD_REGEX,
    ESCAPED_DOUBLE_PERIOD_REGEX,
    REG_KEY_FILE_NAME,
    LOCAL_HARPERDB_OPERATIONS
};

