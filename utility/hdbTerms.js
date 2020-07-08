'use strict';

/**
 * This module should contain common variables/values that will be used across the project.  This should avoid
 * duplicate values making refactoring a little easier.
 */

const COMPILED_EXTENSION = 'jsc';
const JAVASCRIPT_EXTENSION = 'js';
const CODE_EXTENSION = process.env.HDB_COMPILED === 'true' ? COMPILED_EXTENSION : JAVASCRIPT_EXTENSION;

 // Name of the HDB process
const HDB_PROC_NAME = `hdb_express.${CODE_EXTENSION}`;
const SC_PROC_NAME = `Server.${CODE_EXTENSION}`;


const HDB_PROC_DESCRIPTOR = 'HarperDB';
const SC_PROC_DESCRIPTOR = 'Cluster Server';

const HDB_SUPPORT_ADDRESS = 'support@harperdb.io';
const HDB_LICENSE_EMAIL_ADDRESS = 'customer-success@harperdb.io';

const BASIC_LICENSE_MAX_NON_CU_ROLES = 1;
const BASIC_LICENSE_MAX_CLUSTER_CONNS = 3;
const BASIC_LICENSE_CLUSTER_CONNECTION_LIMIT_WS_ERROR_CODE = 4141;
const HDB_SUPPORT_URL = 'https://harperdbhelp.zendesk.com/hc/en-us';
const HDB_PRICING_URL = 'https://https://www.harperdb.io/product';
const SUPPORT_HELP_MSG = `For support, please submit a support request at ${HDB_SUPPORT_URL} or contact ${HDB_SUPPORT_ADDRESS}`;
const LICENSE_HELP_MSG = `For license support, please contact ${HDB_LICENSE_EMAIL_ADDRESS}`;
const SEARCH_NOT_FOUND_MESSAGE = "None of the specified records were found.";
const SEARCH_ATTRIBUTE_NOT_FOUND = `hash attribute not found`;
const LICENSE_ROLE_DENIED_RESPONSE = `Your current license only supports ${BASIC_LICENSE_MAX_NON_CU_ROLES} role.  ${LICENSE_HELP_MSG}`;
const LICENSE_MAX_CONNS_REACHED = 'Your current license only supports 3 connections to a node.';
const LOOPBACK = '127.0.0.1';
const BASIC_LICENSE_MAX_CLUSTER_USER_ROLES = 1;

const PERIOD_REGEX = /^\.$/;
const DOUBLE_PERIOD_REGEX = /^\.\.$/;
const UNICODE_PERIOD = 'U+002E';
const FORWARD_SLASH_REGEX = /\//g;
const UNICODE_FORWARD_SLASH = 'U+002F';
const ESCAPED_FORWARD_SLASH_REGEX = /U\+002F/g;
const ESCAPED_PERIOD_REGEX = /^U\+002E$/;
const ESCAPED_DOUBLE_PERIOD_REGEX = /^U\+002EU\+002E$/;
const MOMENT_DAYS_TAG = 'd';
const API_TURNOVER_SEC = 999999;
const WILDCARD_SEARCH_VALUE = '*';

// Name of the System schema
const SYSTEM_SCHEMA_NAME = 'system';
const HASH_FOLDER_NAME = '__hdb_hash';
const CLUSTERING_VERSION_HEADER_NAME = 'hdb_version';
const HDB_HOME_DIR_NAME = '.harperdb';
const HDB_FILE_SUFFIX = '.hdb';
const LICENSE_KEY_DIR_NAME = 'keys';
const BOOT_PROPS_FILE_NAME = 'hdb_boot_properties.file';
const UPDATE_FILE_NAME = '.updateConfig.json';
const RESTART_CODE = 'SIGTSTP';
const RESTART_CODE_NUM = 24;
const RESTART_TIMEOUT_MS = 60000;
const HDB_FILE_PERMISSIONS = 0o700;
const BLOB_FOLDER_NAME = 'blob';
const HDB_TRASH_DIR = 'trash';
const SCHEMA_DIR_NAME = 'schema';
const TRANSACTIONS_DIR_NAME = 'transactions';
const LIMIT_COUNT_NAME = '.count';
const ID_ATTRIBUTE_STRING = 'id';

const CLUSTERING_PAYLOAD_FILE_NAME = '.scPayload.json';

const CLUSTERING_FOLDER_NAMES_ENUM = {
    CLUSTERING_FOLDER: 'clustering',
    CONNECTIONS_FOLDER: 'connections',
    TRANSACTION_LOG_FOLDER: 'transaction_log',
};

// Trying to keep socket cluster as modular as possible, so we will create values in here that point to values
// inside of the socketcluster types module.
const cluster_types = require('../server/socketcluster/types');
const ClusterMessageObjects = require('../server/socketcluster/room/RoomMessageObjects');
const _ = require('lodash');

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
    ROLE_TABLE_NAME: 'hdb_role',
    SCHEMA_TABLE_NAME: 'hdb_schema',
    TABLE_TABLE_NAME: 'hdb_table',
    USER_TABLE_NAME: 'hdb_user',
    INFO_TABLE_NAME: 'hdb_info'
};

const SYSTEM_TABLE_HASH_ATTRIBUTES = {
    JOB_TABLE_HASH_ATTRIBUTE: 'id',
    NODE_TABLE_HASH_ATTRIBUTE: 'name',
    ATTRIBUTE_TABLE_HASH_ATTRIBUTE: 'id',
    LICENSE_TABLE_HASH_ATTRIBUTE: 'license_key',
    ROLE_TABLE_HASH_ATTRIBUTE: 'id',
    SCHEMA_TABLE_HASH_ATTRIBUTE: 'name',
    TABLE_TABLE_HASH_ATTRIBUTE: 'id',
    USER_TABLE_HASH_ATTRIBUTE: 'username',
    INFO_TABLE_ATTRIBUTE: 'info_id'
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
    SCHEMA_CATCHUP: HDB_INTERNAL_SC_CHANNEL_PREFIX + 'schema_catchup',
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

const LICENSE_FILE_NAME = '.license';

// Describes the available statuses for jobs
const JOB_STATUS_ENUM = {
	CREATED: 'CREATED',
	IN_PROGRESS: 'IN_PROGRESS',
	COMPLETE: 'COMPLETE',
	ERROR: 'ERROR'
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
    GET_REGISTRATION_INFO: 'registration_info',
    CONFIGURE_CLUSTER: 'configure_cluster',
    CLUSTER_STATUS: 'cluster_status',
    DROP_ATTRIBUTE: 'drop_attribute',
    REMOVE_NODE: 'remove_node',
    RESTART: 'restart',
    CATCHUP: 'catchup',
    SYSTEM_INFORMATION: 'system_information'
};

// Defines operations that should be propagated to the cluster.
let CLUSTER_OPERATIONS = {};
CLUSTER_OPERATIONS[OPERATIONS_ENUM.CREATE_SCHEMA] = OPERATIONS_ENUM.CREATE_SCHEMA;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.CREATE_TABLE] = OPERATIONS_ENUM.CREATE_TABLE;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.CREATE_ATTRIBUTE] = OPERATIONS_ENUM.CREATE_ATTRIBUTE;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.INSERT] = OPERATIONS_ENUM.INSERT;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.UPDATE] = OPERATIONS_ENUM.UPDATE;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.DELETE] = OPERATIONS_ENUM.DELETE;

//this variable defines operations that should only run locally and not pass over clustering to another node(s)
const LOCAL_HARPERDB_OPERATIONS = Object.create(null);
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.DESCRIBE_ALL] = OPERATIONS_ENUM.DESCRIBE_ALL;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.DESCRIBE_TABLE] = OPERATIONS_ENUM.DESCRIBE_TABLE;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.DESCRIBE_SCHEMA] = OPERATIONS_ENUM.DESCRIBE_SCHEMA;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.READ_LOG] = OPERATIONS_ENUM.READ_LOG;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.ADD_NODE] = OPERATIONS_ENUM.ADD_NODE;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.LIST_USERS] = OPERATIONS_ENUM.LIST_USERS;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.LIST_ROLES] = OPERATIONS_ENUM.LIST_ROLES;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.USER_INFO] = OPERATIONS_ENUM.USER_INFO;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.SQL] = OPERATIONS_ENUM.SQL;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.GET_JOB] = OPERATIONS_ENUM.GET_JOB;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.SEARCH_JOBS_BY_START_DATE] = OPERATIONS_ENUM.SEARCH_JOBS_BY_START_DATE;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.DELETE_FILES_BEFORE] = OPERATIONS_ENUM.DELETE_FILES_BEFORE;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.EXPORT_LOCAL] = OPERATIONS_ENUM.EXPORT_LOCAL;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.EXPORT_TO_S3] = OPERATIONS_ENUM.EXPORT_TO_S3;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.CLUSTER_STATUS] = OPERATIONS_ENUM.CLUSTER_STATUS;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.REMOVE_NODE] = OPERATIONS_ENUM.REMOVE_NODE;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.RESTART] = OPERATIONS_ENUM.RESTART;

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
    LOG_DAILY_ROTATE_KEY: 'LOG_DAILY_ROTATE',
    LOG_MAX_DAILY_FILES_KEY: 'LOG_MAX_DAILY_FILES',
    PROPS_ENV_KEY: 'NODE_ENV',
    SETTINGS_PATH_KEY: 'settings_path',
    CLUSTERING_PORT_KEY: 'CLUSTERING_PORT',
    CLUSTERING_NODE_NAME_KEY: 'NODE_NAME',
    CLUSTERING_ENABLED_KEY: 'CLUSTERING',
    ALLOW_SELF_SIGNED_SSL_CERTS: 'ALLOW_SELF_SIGNED_SSL_CERTS',
    MAX_HDB_PROCESSES: 'MAX_HDB_PROCESSES',
    INSTALL_USER: 'install_user',
    CLUSTERING_USER_KEY: 'CLUSTERING_USER',
    SERVER_KEEP_ALIVE_TIMEOUT_KEY: 'SERVER_KEEP_ALIVE_TIMEOUT',
    SERVER_HEADERS_TIMEOUT_KEY: 'SERVER_HEADERS_TIMEOUT',
    DISABLE_TRANSACTION_LOG_KEY: 'DISABLE_TRANSACTION_LOG'
};

/**
 * Used for looking up key names by the actual setting field name.
 */

const HDB_SETTINGS_NAMES_REVERSE_LOOKUP = _.invert(HDB_SETTINGS_NAMES);

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
    MAX_HDB_PROCESSES: 4,
    DISABLE_TRANSACTION_LOG: false
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

const STORAGE_TYPES_ENUM = {
    FILE_SYSTEM: 'fs',
    LMDB: 'lmdb'
};

const LICENSE_VALUES = {
    API_CALL_DEFAULT: 10000,
    VERSION_DEFAULT: '2.0.0'
};

// The maximum ram allocation in MB per HDB child process
const RAM_ALLOCATION_ENUM = {
    DEVELOPMENT: 8192, //8GB
    DEFAULT: 1024 //1GB
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

const WEBSOCKET_CLOSE_CODE_DESCRIPTION_LOOKUP = {
    1000 : 'SUCCESSFUL_SHUTDOWN',
    1001 : 'CLOSE_GOING_AWAY',
    1002 : 'CLOSE_PROTOCOL_ERROR',
    1003 : 'CLOSE_UNSUPPORTED',
    1005 : 'CLOSE_NO_STATUS',
    1006 : 'CLOSE_ABNORMAL',
    1007 : 'UNSUPPORTED_PAYLOAD',
    1008 : 'POLICY_VIOLATION',
    1009: 'CLOSE_TOO_LARGE',
    1010: 'MANDATORY_EXTENSION',
    1011: 'SERVER_ERROR',
    1012: 'SERVICE_RESTART',
    1013: 'SERVER_BUSY',
    1014: 'BAD_GATEWAY',
    1015: 'HANDSHAKE_FAIL',
    4141: 'LICENSE_LIMIT_REACHED'
};

const NODE_ERROR_CODES = {
    ENOENT: 'ENOENT',
    EACCES: 'EACCES'
};

const TIME_STAMP_NAMES_ENUM = {
    CREATED_TIME: '__createdtime__',
    UPDATED_TIME: '__updatedtime__'
};

const TIME_STAMP_NAMES = Object.values(TIME_STAMP_NAMES_ENUM);

const VALUE_SEARCH_COMPARATORS = {
    LESS: "<",
    LESS_OR_EQ: "<=",
    GREATER: ">",
    GREATER_OR_EQ: ">=",
    BETWEEN: '...'
};
const VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP = _.invert(VALUE_SEARCH_COMPARATORS);

const CLUSTERING_MESSAGE_TYPES = cluster_types.CORE_ROOM_MSG_TYPE_ENUM;
const ORIGINATOR_SET_VALUE = cluster_types.ORIGINATOR_SET_VALUE;
const NEW_LINE = '\r\n';

/**
 * This object organizes permission checks into a cohesive response object that will be returned to
 * the user in the case of a failed permissions check.
 */
class PermissionResponseObject {
    constructor() {
        this.schema = undefined;
        this.table = undefined;
        this.required_table_permissions = [];
        this.required_attribute_permissions = [];
    }
}

class PermissionAttributeResponseObject {
    constructor() {
        this.attribute_name = undefined;
        this.required_permissions = [];
    }
}

const PERMS_CRUD_ENUM = {
    READ: 'read',
    INSERT: 'insert',
    UPDATE: 'update',
    DELETE: 'delete'
};

const SEARCH_WILDCARDS = ['*', '%'];

const UNAUTHORIZED_PERMISSION_NAME = 'unauthorized_access';

const FUNC_VAL = 'func_val';

module.exports = {
    LOCAL_HARPERDB_OPERATIONS,
    HDB_SUPPORT_ADDRESS,
    HDB_SUPPORT_URL,
    HDB_PRICING_URL,
    SUPPORT_HELP_MSG,
    LICENSE_HELP_MSG,
    HDB_PROC_NAME,
    HDB_PROC_DESCRIPTOR,
    SC_PROC_NAME,
    SC_PROC_DESCRIPTOR,
    SYSTEM_SCHEMA_NAME,
    HASH_FOLDER_NAME,
    HDB_HOME_DIR_NAME,
    UPDATE_FILE_NAME,
    LICENSE_KEY_DIR_NAME,
    BOOT_PROPS_FILE_NAME,
    JOB_TYPE_ENUM,
    JOB_STATUS_ENUM,
    SYSTEM_TABLE_NAMES,
    SYSTEM_TABLE_HASH_ATTRIBUTES,
    OPERATIONS_ENUM,
    GEO_CONVERSION_ENUM,
    HDB_SETTINGS_NAMES,
    HDB_SETTINGS_NAMES_REVERSE_LOOKUP,
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
    SCHEMA_DIR_NAME,
    TRANSACTIONS_DIR_NAME,
    LIMIT_COUNT_NAME,
    ID_ATTRIBUTE_STRING,
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
    HDB_TRASH_DIR,
    // Make the message objects available through hdbTerms to keep clustering as modular as possible.
    ClusterMessageObjects,
    ORIGINATOR_SET_VALUE,
    CLUSTERING_PAYLOAD_FILE_NAME,
    LICENSE_VALUES,
    RAM_ALLOCATION_ENUM,
    STORAGE_TYPES_ENUM,
    TIME_STAMP_NAMES_ENUM,
    TIME_STAMP_NAMES,
    SEARCH_NOT_FOUND_MESSAGE,
    SEARCH_ATTRIBUTE_NOT_FOUND,
    LICENSE_ROLE_DENIED_RESPONSE,
    LICENSE_MAX_CONNS_REACHED,
    BASIC_LICENSE_MAX_NON_CU_ROLES,
    BASIC_LICENSE_MAX_CLUSTER_CONNS,
    BASIC_LICENSE_CLUSTER_CONNECTION_LIMIT_WS_ERROR_CODE,
    VALUE_SEARCH_COMPARATORS,
    VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP,
    LICENSE_FILE_NAME,
    WEBSOCKET_CLOSE_CODE_DESCRIPTION_LOOKUP,
    NEW_LINE,
    BASIC_LICENSE_MAX_CLUSTER_USER_ROLES,
    MOMENT_DAYS_TAG,
    API_TURNOVER_SEC,
    CLUSTERING_FOLDER_NAMES_ENUM,
    LOOPBACK,
    CODE_EXTENSION,
    COMPILED_EXTENSION,
    WILDCARD_SEARCH_VALUE,
    NODE_ERROR_CODES,
    JAVASCRIPT_EXTENSION,
    PermissionResponseObject,
    PermissionAttributeResponseObject,
    PERMS_CRUD_ENUM,
    UNAUTHORIZED_PERMISSION_NAME,
    SEARCH_WILDCARDS,
    FUNC_VAL
};
