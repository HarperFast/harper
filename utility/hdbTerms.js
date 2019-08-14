'use strict';

/**
 * This module should contain common variables/values that will be used across the project.  This should avoid
 * duplicate values making refactoring a little easier.
 */

 // Name of the HDB process
const HDB_PROC_NAME = 'hdb_express.js';
const SC_PROC_NAME = 'Server.js';

const HDB_PROC_DESCRIPTOR = 'HarperDB';
const SC_PROC_DESCRIPTOR = 'Cluster Server';

const HDB_SUPPORT_ADDRESS = 'support@harperdb.io';
const HDB_SUPPORT_URL = 'https://harperdbhelp.zendesk.com/hc/en-us';
const SUPPORT_HELP_MSG = `For support, please submit a support request at ${HDB_SUPPORT_URL} or contact ${HDB_SUPPORT_ADDRESS}`;

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
const HASH_FOLDER_NAME = '__hdb_hash';
const CLUSTERING_VERSION_HEADER_NAME = 'hdb_version';
const HDB_HOME_DIR_NAME = '.harperdb';
const LICENSE_KEY_DIR_NAME = 'keys';
const BOOT_PROPS_FILE_NAME = 'hdb_boot_properties.file';
const UPDATE_FILE_NAME = '.updateConfig.json';
const HDB_INFO_TABLE_NAME = 'hdb_info';
const HDB_INTO_TABLE_HASH_ATTRIBUTE = 'id';
const RESTART_CODE = 'SIGTSTP';
const RESTART_CODE_NUM = 24;
const RESTART_TIMEOUT_MS = 60000;
const HDB_FILE_PERMISSIONS = 0o700;
const HDB_FILE_SUFFIX = '.hdb';
const BLOB_FOLDER_NAME = 'blob';

// Trying to keep socket cluster as modular as possible, so we will create values in here that point to values
// inside of the socketcluster types module.
const cluster_types = require('../server/socketcluster/types');
const ClusterMessageObjects = require('../server/socketcluster/room/RoomMessageObjects');

const INSERT_MODULE_ENUM = {
    HDB_PATH_KEY: 'HDB_INTERNAL_PATH',
    HDB_AUTH_HEADER: 'hdb_auth_header',
    HDB_USER_DATA_KEY: 'hdb_user',
    CHUNK_SIZE: 1000,
    MAX_CHARACTER_SIZE: 250
};

const UPGRADE_JSON_FIELD_NAMES_ENUM = {
    CURRENT_VERSION: 'currentVersion',
    UPGRADE_VERSION: 'upgradeVersion'
};

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
};

const HDB_INTERNAL_SC_CHANNEL_PREFIX = 'hdb_internal:';

const INTERNAL_SC_CHANNELS = {
    CREATE_SCHEMA: HDB_INTERNAL_SC_CHANNEL_PREFIX + 'create_schema',
    CREATE_TABLE: HDB_INTERNAL_SC_CHANNEL_PREFIX + 'create_table',
    CREATE_ATTRIBUTE: HDB_INTERNAL_SC_CHANNEL_PREFIX + 'create_attribute',
    ADD_USER: HDB_INTERNAL_SC_CHANNEL_PREFIX + 'add_user',
    ALTER_USER: HDB_INTERNAL_SC_CHANNEL_PREFIX + 'alter_user',
    DROP_USER: HDB_INTERNAL_SC_CHANNEL_PREFIX + 'drop_user',
    HDB_NODES: HDB_INTERNAL_SC_CHANNEL_PREFIX + 'hdb_nodes',
    HDB_USERS: HDB_INTERNAL_SC_CHANNEL_PREFIX + 'hdb_users',
    HDB_WORKERS: HDB_INTERNAL_SC_CHANNEL_PREFIX + 'hdb_workers',
    CATCHUP: HDB_INTERNAL_SC_CHANNEL_PREFIX + 'catchup',
    WORKER_ROOM: HDB_INTERNAL_SC_CHANNEL_PREFIX + 'cluster_workers'
};

const SYSTEM_DEFAULT_ATTRIBUTE_NAMES = {
    ATTR_ATTRIBUTE_KEY: "attribute",
    ATTR_CREATEDDATE_KEY: "createddate",
    ATTR_HASH_ATTRIBUTE_KEY: "hash_attribute",
    ATTR_ID_KEY: "id",
    ATTR_NAME_KEY: "name",
    ATTR_PASSWORD_KEY: "password",
    ATTR_RESIDENCE_KEY: "residence",
    ATTR_ROLE_KEY: "role",
    ATTR_SCHEMA_KEY: "schema",
    ATTR_SCHEMA_TABLE_KEY: "schema_table",
    ATTR_TABLE_KEY: "table",
    ATTR_USERNAME_KEY: "username"
};

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
    UPDATE_NODE: 'update_node',
    EXPORT_TO_S3: 'export_to_s3',
    DELETE_FILES_BEFORE: 'delete_files_before',
    EXPORT_LOCAL: 'export_local',
    SEARCH_JOBS_BY_START_DATE: 'search_jobs_by_start_date',
    GET_JOB: 'get_job',
    DELETE_JOB: 'delete_job',
    UPDATE_JOB: 'update_job',
    GET_FINGERPRINT: 'get_fingerprint',
    SET_LICENSE: 'set_license',
    CONFIGURE_CLUSTER: 'configure_cluster',
    CLUSTER_STATUS: 'cluster_status',
    DROP_ATTRIBUTE: 'drop_attribute',
    REMOVE_NODE: 'remove_node',
    RESTART: 'restart',
    CATCHUP: 'catchup'
};

// Defines operations that should be propagated to the cluster.
let CLUSTER_OPERATIONS = {};
CLUSTER_OPERATIONS[OPERATIONS_ENUM.CREATE_SCHEMA] = OPERATIONS_ENUM.CREATE_SCHEMA;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.CREATE_TABLE] = OPERATIONS_ENUM.CREATE_TABLE;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.CREATE_ATTRIBUTE] = OPERATIONS_ENUM.CREATE_ATTRIBUTE;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.CSV_DATA_LOAD] = OPERATIONS_ENUM.CSV_DATA_LOAD;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.CSV_FILE_LOAD] = OPERATIONS_ENUM.CSV_FILE_LOAD;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.CSV_URL_LOAD] = OPERATIONS_ENUM.CSV_URL_LOAD;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.INSERT] = OPERATIONS_ENUM.INSERT;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.UPDATE] = OPERATIONS_ENUM.UPDATE;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.DELETE] = OPERATIONS_ENUM.DELETE;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.SEARCH_BY_HASH] = OPERATIONS_ENUM.SEARCH_BY_HASH;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.SEARCH_BY_VALUE] = OPERATIONS_ENUM.SEARCH_BY_VALUE;

//this variable defines operations that should only run locally and not pass over clustering to another node(s)
const LOCAL_HARPERDB_OPERATIONS = [OPERATIONS_ENUM.DESCRIBE_ALL, OPERATIONS_ENUM.DESCRIBE_TABLE, OPERATIONS_ENUM.DESCRIBE_SCHEMA,
    OPERATIONS_ENUM.READ_LOG, OPERATIONS_ENUM.ADD_NODE, OPERATIONS_ENUM.LIST_USERS, OPERATIONS_ENUM.LIST_ROLES, OPERATIONS_ENUM.USER_INFO,
    OPERATIONS_ENUM.SQL, OPERATIONS_ENUM.GET_JOB, OPERATIONS_ENUM.SEARCH_JOBS_BY_START_DATE, OPERATIONS_ENUM.DELETE_FILES_BEFORE,
    OPERATIONS_ENUM.EXPORT_LOCAL, OPERATIONS_ENUM.EXPORT_TO_S3, OPERATIONS_ENUM.CLUSTER_STATUS, OPERATIONS_ENUM.REMOVE_NODE, OPERATIONS_ENUM.RESTART];

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

const HDB_DATA_STORE_TYPES = {
    FILE_SYSTEM: 'FILE_SYSTEM',
    HELIUM: 'HELIUM'
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
    LOG_DAILY_ROTATE_KEY: 'LOG_DAILY_ROTATE',
    LOG_MAX_DAILY_FILES_KEY: 'LOG_MAX_DAILY_FILES',
    PROPS_ENV_KEY: 'NODE_ENV',
    SETTINGS_PATH_KEY: 'settings_path',
    CLUSTERING_PORT_KEY: 'CLUSTERING_PORT',
    CLUSTERING_NODE_NAME_KEY: 'NODE_NAME',
    CLUSTERING_ENABLED_KEY: 'CLUSTERING',
    ALLOW_SELF_SIGNED_SSL_CERTS: 'ALLOW_SELF_SIGNED_SSL_CERTS',
    MAX_HDB_PROCESSES: 'MAX_HDB_PROCESSES',
    INSTALL_USER: 'install_user'
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
    LOG_DAILY_ROTATE_KEY: 'false',
    LOG_MAX_DAILY_FILES_KEY: '',
    NODE_ENV: 'production',
    CLUSTERING_PORT: '5545',
    CLUSTERING: 'false',
    MAX_HDB_PROCESSES: 4
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

const CLUSTER_MESSAGE_TYPE_ENUM = {
    CLUSTERING_PAYLOAD: 'clustering_payload',
    DELEGATE_THREAD_RESPONSE: 'delegate_thread_response',
    CLUSTERING: 'clustering',
    SCHEMA: 'schema',
    CLUSTER_STATUS: 'cluster_status',
    JOB: 'job',
    CHILD_STARTED: 'child_started',
    CHILD_STOPPED: 'child_stopped',
    USER: 'user',
    RESTART: 'restart'
};
const CLUSTER_CONNECTION_DIRECTION_ENUM = {
    // Data flows to both the client and this server
    BIDIRECTIONAL: "BIDIRECTIONAL",
    // This server only sends data to its client, it doesn't up update from received data
    OUTBOUND: "OUTBOUND",
    // This server only receives data, it does not send updated data
    INBOUND: "INBOUND"
};

const CLUSTER_EVENTS_DEFS_ENUM = {
    IDENTIFY : 'identify',
    AUTHENTICATE : 'authenticate',
    AUTHENTICATE_OK: 'authenticated',
    AUTHENTICATE_FAIL: 'authenticate_fail',
    CONNECTION: 'connection',
    CONNECT: 'connect',
    CATCHUP_REQUEST : 'catchup_request',
    CATCHUP_RESPONSE: 'catchup',
    CONFIRM_MSG: 'confirm_msg',
    ERROR: 'error',
    DISCONNECT: 'disconnect',
    SCHEMA_UPDATE_REQ: 'schema_update_request',
    SCHEMA_UPDATE_RES: 'schema_update_response',
    RECONNECT_ATTEMPT: 'reconnect_attempt',
    CONNECT_ERROR: 'connect_error',
    MESSAGE: 'msg',
    VERSION_MISMATCH: 'version_mismatch',
    DIRECTION_CHANGE: 'direction_change'
};

const CLUSTERING_MESSAGE_TYPES = cluster_types.CORE_ROOM_MSG_TYPE_ENUM;

module.exports = {
    LOCAL_HARPERDB_OPERATIONS,
    HDB_SUPPORT_ADDRESS,
    HDB_SUPPORT_URL,
    SUPPORT_HELP_MSG,
    HDB_PROC_NAME,
    HDB_PROC_DESCRIPTOR,
    SC_PROC_NAME,
    SC_PROC_DESCRIPTOR,
    SYSTEM_SCHEMA_NAME,
    HDB_INFO_TABLE_NAME,
    HDB_INTO_TABLE_HASH_ATTRIBUTE,
    HASH_FOLDER_NAME,
    HDB_HOME_DIR_NAME,
    UPDATE_FILE_NAME,
    LICENSE_KEY_DIR_NAME,
    CLUSTERING_VERSION_HEADER_NAME,
    BOOT_PROPS_FILE_NAME,
    JOB_TYPE_ENUM,
    JOB_STATUS_ENUM,
    SYSTEM_TABLE_NAMES,
    OPERATIONS_ENUM,
    HTTP_STATUS_CODES,
    GEO_CONVERSION_ENUM,
    HDB_DATA_STORE_TYPES,
    HDB_SETTINGS_NAMES,
    HDB_SETTINGS_DEFAULT_VALUES,
    SERVICE_ACTIONS_ENUM,
    CLUSTER_MESSAGE_TYPE_ENUM,
    CLUSTER_CONNECTION_DIRECTION_ENUM,
    CLUSTER_EVENTS_DEFS_ENUM,
    PERIOD_REGEX,
    DOUBLE_PERIOD_REGEX,
    UNICODE_PERIOD,
    FORWARD_SLASH_REGEX,
    UNICODE_FORWARD_SLASH,
    ESCAPED_FORWARD_SLASH_REGEX,
    ESCAPED_PERIOD_REGEX,
    ESCAPED_DOUBLE_PERIOD_REGEX,
    REG_KEY_FILE_NAME,
    RESTART_TIMEOUT_MS,
    HDB_FILE_PERMISSIONS,
    INSERT_MODULE_ENUM,
    UPGRADE_JSON_FIELD_NAMES_ENUM,
    RESTART_CODE,
    RESTART_CODE_NUM,
    CLUSTER_OPERATIONS,
    SYSTEM_DEFAULT_ATTRIBUTE_NAMES,
    HDB_INTERNAL_SC_CHANNEL_PREFIX,
    INTERNAL_SC_CHANNELS,
    CLUSTERING_MESSAGE_TYPES,
    HDB_FILE_SUFFIX,
    BLOB_FOLDER_NAME,
    // Make the message objects available through hdbTerms to keep clustering as modular as possible.
    ClusterMessageObjects
};

