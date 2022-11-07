'use strict';

const path = require('path');
const fs = require('fs');
/**
 * Finds and returns the package root directory
 * @returns {string}
 */
function getHDBPackageRoot() {
	let dir = __dirname;
	while (!fs.existsSync(path.join(dir, 'package.json'))) {
		let parent = path.dirname(dir);
		if (parent === dir) throw new Error('Could not find package root');
		dir = parent;
	}
	return dir;
}
const PACKAGE_ROOT = getHDBPackageRoot();

/**
 * This module should contain common variables/values that will be used across the project.  This should avoid
 * duplicate values making refactoring a little easier.
 */

const JAVASCRIPT_EXTENSION = 'js';
const CODE_EXTENSION = JAVASCRIPT_EXTENSION;

const HDB_CONFIG_FILE = 'harperdb-config.yaml';
const HDB_DEFAULT_CONFIG_FILE = 'defaultConfig.yaml';
const HDB_ROOT_DIR_NAME = 'hdb';

// Name of the HDB process
const HDB_PROC_NAME = `hdbServer.${CODE_EXTENSION}`;
const CUSTOM_FUNCTION_PROC_NAME = `customFunctionsServer.${CODE_EXTENSION}`;
const IPC_SERVER_MODULE = `hdbIpcServer.${CODE_EXTENSION}`;
const HDB_RESTART_SCRIPT = `restartHdb.${CODE_EXTENSION}`;

const HDB_PROC_DESCRIPTOR = 'HarperDB';
const CUSTOM_FUNCTION_PROC_DESCRIPTOR = 'Custom Functions';
const CLUSTERING_HUB_PROC_DESCRIPTOR = 'Clustering Hub';
const CLUSTERING_LEAF_PROC_DESCRIPTOR = 'Clustering Leaf';
const CLUSTERING_INGEST_PROC_DESCRIPTOR = 'Clustering Ingest Service';
const CLUSTERING_REPLY_SERVICE_DESCRIPTOR = 'Clustering Reply Service';

const FOREGROUND_PID_FILE = 'foreground.pid';

const PROCESS_DESCRIPTORS = {
	HDB: HDB_PROC_DESCRIPTOR,
	IPC: 'IPC',
	CLUSTERING_HUB: CLUSTERING_HUB_PROC_DESCRIPTOR,
	CLUSTERING_LEAF: CLUSTERING_LEAF_PROC_DESCRIPTOR,
	CLUSTERING_INGEST_SERVICE: CLUSTERING_INGEST_PROC_DESCRIPTOR,
	CLUSTERING_REPLY_SERVICE: CLUSTERING_REPLY_SERVICE_DESCRIPTOR,
	CUSTOM_FUNCTIONS: CUSTOM_FUNCTION_PROC_DESCRIPTOR,
	RESTART_HDB: 'Restart HDB',
	INSTALL: 'Install',
	RUN: 'Run',
	STOP: 'Stop',
	UPGRADE: 'Upgrade',
	REGISTER: 'Register',
	JOB: 'Job',
	PM2_LOGROTATE: 'pm2-logrotate',
	CLUSTERING_UPGRADE_4_0_0: 'Upgrade-4-0-0',
};

const PROCESS_LOG_NAMES = {
	HDB: 'hdb.log',
	IPC: 'ipc.log',
	CLUSTERING_HUB: 'clustering_hub.log',
	CLUSTERING_LEAF: 'clustering_leaf.log',
	CLUSTERING_INGEST_SERVICE: 'clustering_ingest_service.log',
	CLUSTERING_REPLY_SERVICE: 'clustering_reply_service.log',
	CUSTOM_FUNCTIONS: 'custom_functions.log',
	INSTALL: 'install.log',
	CLI: 'cli.log',
	PM2: 'pm2.log',
	CLUSTERING_UPGRADE: 'clustering_upgrade.log',
	JOBS: 'jobs.log',
};

const LOG_LEVELS = {
	NOTIFY: 'notify',
	FATAL: 'fatal',
	ERROR: 'error',
	WARN: 'warn',
	INFO: 'info',
	DEBUG: 'debug',
	TRACE: 'trace',
};

const PROCESS_DESCRIPTORS_VALIDATE = {
	'harperdb': HDB_PROC_DESCRIPTOR,
	'ipc': 'IPC',
	'clustering hub': CLUSTERING_HUB_PROC_DESCRIPTOR,
	'clustering leaf': CLUSTERING_LEAF_PROC_DESCRIPTOR,
	'clustering ingest service': CLUSTERING_INGEST_PROC_DESCRIPTOR,
	'clustering reply service': CLUSTERING_REPLY_SERVICE_DESCRIPTOR,
	'custom functions': CUSTOM_FUNCTION_PROC_DESCRIPTOR,
	'custom_functions': CUSTOM_FUNCTION_PROC_DESCRIPTOR,
	'pm2-logrotate': PROCESS_DESCRIPTORS.PM2_LOGROTATE,
	'logrotate': PROCESS_DESCRIPTORS.PM2_LOGROTATE,
	'clustering': 'clustering',
	'clustering config': 'clustering config',
};

// All the processes that make up clustering
const CLUSTERING_PROCESSES = {
	CLUSTERING_HUB_PROC_DESCRIPTOR,
	CLUSTERING_LEAF_PROC_DESCRIPTOR,
	CLUSTERING_INGEST_PROC_DESCRIPTOR,
	CLUSTERING_REPLY_SERVICE_DESCRIPTOR,
};

const SERVICE_SERVERS_CWD = {
	HDB: path.join(PACKAGE_ROOT, `server/harperdb`),
	IPC: path.join(PACKAGE_ROOT, `server/ipc`),
	CUSTOM_FUNCTIONS: path.join(PACKAGE_ROOT, `server/customFunctions`),
	CLUSTERING_HUB: path.join(PACKAGE_ROOT, 'server/nats'),
	CLUSTERING_LEAF: path.join(PACKAGE_ROOT, 'server/nats'),
};

const SERVICE_SERVERS = {
	HDB: path.join(SERVICE_SERVERS_CWD.HDB, HDB_PROC_NAME),
	IPC: path.join(SERVICE_SERVERS_CWD.IPC, IPC_SERVER_MODULE),
	CUSTOM_FUNCTIONS: path.join(SERVICE_SERVERS_CWD.CUSTOM_FUNCTIONS, CUSTOM_FUNCTION_PROC_NAME),
};

const LAUNCH_SERVICE_SCRIPTS = {
	MAIN: 'bin/harperdb.js',
	HDB: path.join(PACKAGE_ROOT, 'launchServiceScripts/launchHarperDB.js'),
	CUSTOM_FUNCTIONS: path.join(PACKAGE_ROOT, 'launchServiceScripts/launchCustomFunctions.js'),
	NATS_INGEST_SERVICE: path.join(PACKAGE_ROOT, 'launchServiceScripts/launchNatsIngestService.js'),
	NATS_REPLY_SERVICE: path.join(PACKAGE_ROOT, 'launchServiceScripts/launchNatsReplyService.js'),
	NODES_UPGRADE_4_0_0: path.join(PACKAGE_ROOT, 'launchServiceScripts/launchUpdateNodes4-0-0.js'),
};

const ROLE_TYPES_ENUM = {
	SUPER_USER: 'super_user',
	CLUSTER_USER: 'cluster_user',
};

const HDB_SUPPORT_ADDRESS = 'support@harperdb.io';
const HDB_LICENSE_EMAIL_ADDRESS = 'customer-success@harperdb.io';

const BASIC_LICENSE_MAX_NON_CU_ROLES = 1;
const BASIC_LICENSE_CLUSTER_CONNECTION_LIMIT_WS_ERROR_CODE = 4141;
const HDB_SUPPORT_URL = 'https://harperdbhelp.zendesk.com/hc/en-us/requests/new';
const HDB_PRICING_URL = 'https://www.harperdb.io/product';
const SUPPORT_HELP_MSG = `For support, please submit a request at ${HDB_SUPPORT_URL} or contact ${HDB_SUPPORT_ADDRESS}`;
const LICENSE_HELP_MSG = `For license support, please contact ${HDB_LICENSE_EMAIL_ADDRESS}`;
const SEARCH_NOT_FOUND_MESSAGE = 'None of the specified records were found.';
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

const MEM_SETTING_KEY = '--max-old-space-size=';

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

const INSTALL_LOG = 'install_log.log';
const RUN_LOG = 'run_log.log';

const PROCESS_NAME_ENV_PROP = 'PROCESS_NAME';

const BOOT_PROP_PARAMS = {
	SETTINGS_PATH_KEY: 'settings_path',
};

const _ = require('lodash');

const INSTALL_PROMPTS = {
	TC_AGREEMENT: 'TC_AGREEMENT',
	CLUSTERING_USER: 'CLUSTERING_USER',
	CLUSTERING_PASSWORD: 'CLUSTERING_PASSWORD',
	HDB_ADMIN_USERNAME: 'HDB_ADMIN_USERNAME',
	HDB_ADMIN_PASSWORD: 'HDB_ADMIN_PASSWORD',
	OPERATIONSAPI_ROOT: 'OPERATIONSAPI_ROOT',
	ROOTPATH: 'ROOTPATH',
	OPERATIONSAPI_NETWORK_PORT: 'OPERATIONSAPI_NETWORK_PORT',
	CLUSTERING_NODENAME: 'CLUSTERING_NODENAME',
	CLUSTERING_ENABLED: 'CLUSTERING_ENABLED',
	// Prompts below are pre 4.0.0 release
	CLUSTERING_PORT: 'CLUSTERING_PORT',
	HDB_ROOT: 'HDB_ROOT',
	SERVER_PORT: 'SERVER_PORT',
	NODE_NAME: 'NODE_NAME',
	CLUSTERING: 'CLUSTERING',
};

const INSERT_MODULE_ENUM = {
	HDB_PATH_KEY: 'HDB_INTERNAL_PATH',
	HDB_AUTH_HEADER: 'hdb_auth_header',
	HDB_USER_DATA_KEY: 'hdb_user',
	CHUNK_SIZE: 1000,
	MAX_CHARACTER_SIZE: 250,
};

const UPGRADE_JSON_FIELD_NAMES_ENUM = {
	DATA_VERSION: 'data_version',
	UPGRADE_VERSION: 'upgrade_version',
};

const SYSTEM_TABLE_NAMES = {
	JOB_TABLE_NAME: 'hdb_job',
	NODE_TABLE_NAME: 'hdb_nodes',
	ATTRIBUTE_TABLE_NAME: 'hdb_attribute',
	LICENSE_TABLE_NAME: 'hdb_license',
	ROLE_TABLE_NAME: 'hdb_role',
	SCHEMA_TABLE_NAME: 'hdb_schema',
	TABLE_TABLE_NAME: 'hdb_table',
	USER_TABLE_NAME: 'hdb_user',
	INFO_TABLE_NAME: 'hdb_info',
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
	INFO_TABLE_ATTRIBUTE: 'info_id',
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
	WORKER_ROOM: HDB_INTERNAL_SC_CHANNEL_PREFIX + 'cluster_workers',
};

const SYSTEM_DEFAULT_ATTRIBUTE_NAMES = {
	ATTR_ATTRIBUTE_KEY: 'attribute',
	ATTR_CREATEDDATE_KEY: 'createddate',
	ATTR_HASH_ATTRIBUTE_KEY: 'hash_attribute',
	ATTR_ID_KEY: 'id',
	ATTR_NAME_KEY: 'name',
	ATTR_PASSWORD_KEY: 'password',
	ATTR_RESIDENCE_KEY: 'residence',
	ATTR_ROLE_KEY: 'role',
	ATTR_SCHEMA_KEY: 'schema',
	ATTR_SCHEMA_TABLE_KEY: 'schema_table',
	ATTR_TABLE_KEY: 'table',
	ATTR_USERNAME_KEY: 'username',
};

// Registration key file name
const REG_KEY_FILE_NAME = '060493.ks';

const LICENSE_FILE_NAME = '.license';

// Describes the available statuses for jobs
const JOB_STATUS_ENUM = {
	CREATED: 'CREATED',
	IN_PROGRESS: 'IN_PROGRESS',
	COMPLETE: 'COMPLETE',
	ERROR: 'ERROR',
};

// Operations
const OPERATIONS_ENUM = {
	INSERT: 'insert',
	UPDATE: 'update',
	UPSERT: 'upsert',
	SEARCH_BY_CONDITIONS: 'search_by_conditions',
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
	IMPORT_FROM_S3: 'import_from_s3',
	DELETE_FILES_BEFORE: 'delete_files_before',
	DELETE_RECORDS_BEFORE: 'delete_records_before',
	EXPORT_LOCAL: 'export_local',
	SEARCH_JOBS_BY_START_DATE: 'search_jobs_by_start_date',
	GET_JOB: 'get_job',
	DELETE_JOB: 'delete_job',
	UPDATE_JOB: 'update_job',
	GET_FINGERPRINT: 'get_fingerprint',
	SET_LICENSE: 'set_license',
	GET_REGISTRATION_INFO: 'registration_info',
	CONFIGURE_CLUSTER: 'configure_cluster',
	SET_CONFIGURATION: 'set_configuration',
	CLUSTER_STATUS: 'cluster_status',
	DROP_ATTRIBUTE: 'drop_attribute',
	REMOVE_NODE: 'remove_node',
	RESTART: 'restart',
	RESTART_SERVICE: 'restart_service',
	CATCHUP: 'catchup',
	SYSTEM_INFORMATION: 'system_information',
	DELETE_AUDIT_LOGS_BEFORE: 'delete_audit_logs_before',
	READ_AUDIT_LOG: 'read_audit_log',
	CREATE_AUTHENTICATION_TOKENS: 'create_authentication_tokens',
	REFRESH_OPERATION_TOKEN: 'refresh_operation_token',
	GET_CONFIGURATION: 'get_configuration',
	CUSTOM_FUNCTIONS_STATUS: 'custom_functions_status',
	GET_CUSTOM_FUNCTIONS: 'get_custom_functions',
	GET_CUSTOM_FUNCTION: 'get_custom_function',
	SET_CUSTOM_FUNCTION: 'set_custom_function',
	DROP_CUSTOM_FUNCTION: 'drop_custom_function',
	ADD_CUSTOM_FUNCTION_PROJECT: 'add_custom_function_project',
	DROP_CUSTOM_FUNCTION_PROJECT: 'drop_custom_function_project',
	PACKAGE_CUSTOM_FUNCTION_PROJECT: 'package_custom_function_project',
	DEPLOY_CUSTOM_FUNCTION_PROJECT: 'deploy_custom_function_project',
	CLUSTER_SET_ROUTES: 'cluster_set_routes',
	CLUSTER_DELETE_ROUTES: 'cluster_delete_routes',
	CLUSTER_GET_ROUTES: 'cluster_get_routes',
	READ_TRANSACTION_LOG: 'read_transaction_log',
	DELETE_TRANSACTION_LOGS_BEFORE: 'delete_transaction_logs_before',
	INSTALL_NODE_MODULES: 'install_node_modules',
	AUDIT_NODE_MODULES: 'audit_node_modules',
};

// Defines valid file types that we are able to handle in 'import_from_s3' ops
const VALID_S3_FILE_TYPES = {
	CSV: '.csv',
	JSON: '.json',
};

// Defines the keys required in a request body for accessing a S3 bucket
const S3_BUCKET_AUTH_KEYS = {
	AWS_ACCESS_KEY: 'aws_access_key_id',
	AWS_SECRET: 'aws_secret_access_key',
	AWS_BUCKET: 'bucket',
	AWS_FILE_KEY: 'key',
};

// Defines valid SQL operations to be used in the processAST method - this ensure we have appropriate unit test coverage
// for all SQL operations that are dynamically set after the chooseOperation method which behaves differently for the
// evaluateSQL operation.
const VALID_SQL_OPS_ENUM = {
	SELECT: 'select',
	INSERT: 'insert',
	UPDATE: 'update',
	DELETE: 'delete',
};

// Defines operations that should be propagated to the cluster.
let CLUSTER_OPERATIONS = {};
CLUSTER_OPERATIONS[OPERATIONS_ENUM.CREATE_SCHEMA] = OPERATIONS_ENUM.CREATE_SCHEMA;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.CREATE_TABLE] = OPERATIONS_ENUM.CREATE_TABLE;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.CREATE_ATTRIBUTE] = OPERATIONS_ENUM.CREATE_ATTRIBUTE;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.INSERT] = OPERATIONS_ENUM.INSERT;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.UPDATE] = OPERATIONS_ENUM.UPDATE;
CLUSTER_OPERATIONS[OPERATIONS_ENUM.UPSERT] = OPERATIONS_ENUM.UPSERT;
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
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.CUSTOM_FUNCTIONS_STATUS] = OPERATIONS_ENUM.CUSTOM_FUNCTIONS_STATUS;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.GET_CUSTOM_FUNCTIONS] = OPERATIONS_ENUM.GET_CUSTOM_FUNCTIONS;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.GET_CUSTOM_FUNCTION] = OPERATIONS_ENUM.GET_CUSTOM_FUNCTION;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.SET_CUSTOM_FUNCTION] = OPERATIONS_ENUM.SET_CUSTOM_FUNCTION;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.DROP_CUSTOM_FUNCTION] = OPERATIONS_ENUM.DROP_CUSTOM_FUNCTION;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.ADD_CUSTOM_FUNCTION_PROJECT] = OPERATIONS_ENUM.ADD_CUSTOM_FUNCTION_PROJECT;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.DROP_CUSTOM_FUNCTION_PROJECT] = OPERATIONS_ENUM.DROP_CUSTOM_FUNCTION_PROJECT;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.PACKAGE_CUSTOM_FUNCTION_PROJECT] =
	OPERATIONS_ENUM.PACKAGE_CUSTOM_FUNCTION_PROJECT;
LOCAL_HARPERDB_OPERATIONS[OPERATIONS_ENUM.DEPLOY_CUSTOM_FUNCTION_PROJECT] =
	OPERATIONS_ENUM.DEPLOY_CUSTOM_FUNCTION_PROJECT;

const SERVICE_ACTIONS_ENUM = {
	RUN: 'run',
	INSTALL: 'install',
	REGISTER: 'register',
	STOP: 'stop',
	RESTART: 'restart',
	VERSION: 'version',
	UPGRADE: 'upgrade',
};

//describes the Geo Conversion types
const GEO_CONVERSION_ENUM = {
	point: 'point',
	lineString: 'lineString',
	multiLineString: 'multiLineString',
	multiPoint: 'multiPoint',
	multiPolygon: 'multiPolygon',
	polygon: 'polygon',
};

// These values are relics of before the config was converted to yaml.
// The should no longer be used. Instead use CONFIG_PARAMS.
const HDB_SETTINGS_NAMES = {
	HDB_ROOT_KEY: 'HDB_ROOT',
	SERVER_PORT_KEY: 'SERVER_PORT',
	CERT_KEY: 'CERTIFICATE',
	PRIVATE_KEY_KEY: 'PRIVATE_KEY',
	HTTP_SECURE_ENABLED_KEY: 'HTTPS_ON',
	CORS_ENABLED_KEY: 'CORS_ON',
	CORS_WHITELIST_KEY: 'CORS_WHITELIST',
	LOG_LEVEL_KEY: 'LOG_LEVEL',
	LOGGER_KEY: 'LOGGER',
	LOG_PATH_KEY: 'LOG_PATH',
	LOG_ROTATE: 'LOG_ROTATE',
	LOG_ROTATE_MAX_SIZE: 'LOG_ROTATE_MAX_SIZE',
	LOG_ROTATE_RETAIN: 'LOG_ROTATE_RETAIN',
	LOG_ROTATE_COMPRESS: 'LOG_ROTATE_COMPRESS',
	LOG_ROTATE_DATE_FORMAT: 'LOG_ROTATE_DATE_FORMAT',
	LOG_ROTATE_ROTATE_MODULE: 'LOG_ROTATE_ROTATE_MODULE',
	LOG_ROTATE_WORKER_INTERVAL: 'LOG_ROTATE_WORKER_INTERVAL',
	LOG_ROTATE_ROTATE_INTERVAL: 'LOG_ROTATE_ROTATE_INTERVAL',
	LOG_ROTATE_TIMEZONE: 'LOG_ROTATE_TIMEZONE',
	LOG_DAILY_ROTATE_KEY: 'LOG_DAILY_ROTATE',
	LOG_MAX_DAILY_FILES_KEY: 'LOG_MAX_DAILY_FILES',
	PROPS_ENV_KEY: 'NODE_ENV',
	SETTINGS_PATH_KEY: 'settings_path', // This value is used in the boot prop file not the settings file. It should stay lowercase.
	CLUSTERING_PORT_KEY: 'CLUSTERING_PORT',
	CLUSTERING_NODE_NAME_KEY: 'NODE_NAME',
	CLUSTERING_ENABLED_KEY: 'CLUSTERING',
	ALLOW_SELF_SIGNED_SSL_CERTS: 'ALLOW_SELF_SIGNED_SSL_CERTS',
	MAX_HDB_PROCESSES: 'MAX_HDB_PROCESSES',
	INSTALL_USER: 'install_user', // This value is used in the boot prop file not the settings file. It should stay lowercase.
	CLUSTERING_USER_KEY: 'CLUSTERING_USER',
	MAX_CLUSTERING_PROCESSES: 'MAX_CLUSTERING_PROCESSES',
	SERVER_TIMEOUT_KEY: 'SERVER_TIMEOUT_MS',
	SERVER_KEEP_ALIVE_TIMEOUT_KEY: 'SERVER_KEEP_ALIVE_TIMEOUT',
	SERVER_HEADERS_TIMEOUT_KEY: 'SERVER_HEADERS_TIMEOUT',
	DISABLE_TRANSACTION_LOG_KEY: 'DISABLE_TRANSACTION_LOG',
	OPERATION_TOKEN_TIMEOUT_KEY: 'OPERATION_TOKEN_TIMEOUT',
	REFRESH_TOKEN_TIMEOUT_KEY: 'REFRESH_TOKEN_TIMEOUT',
	IPC_SERVER_PORT: 'IPC_SERVER_PORT',
	CUSTOM_FUNCTIONS_ENABLED_KEY: 'CUSTOM_FUNCTIONS',
	CUSTOM_FUNCTIONS_PORT_KEY: 'CUSTOM_FUNCTIONS_PORT',
	CUSTOM_FUNCTIONS_DIRECTORY_KEY: 'CUSTOM_FUNCTIONS_DIRECTORY',
	MAX_CUSTOM_FUNCTION_PROCESSES: 'MAX_CUSTOM_FUNCTION_PROCESSES',
	LOG_TO_FILE: 'LOG_TO_FILE',
	LOG_TO_STDSTREAMS: 'LOG_TO_STDSTREAMS',
	RUN_IN_FOREGROUND: 'RUN_IN_FOREGROUND',
	LOCAL_STUDIO_ON: 'LOCAL_STUDIO_ON',
	STORAGE_WRITE_ASYNC: 'STORAGE_WRITE_ASYNC',
};

/**
 * Used for looking up key names by the actual setting field name.
 */

const HDB_SETTINGS_NAMES_REVERSE_LOOKUP = _.invert(HDB_SETTINGS_NAMES);

// If a param is added to config it must also be added here.
const CONFIG_PARAMS = {
	CLUSTERING_USER: 'clustering_user',
	CLUSTERING_ENABLED: 'clustering_enabled',
	CLUSTERING_HUBSERVER_CLUSTER_NAME: 'clustering_hubServer_cluster_name',
	CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT: 'clustering_hubServer_cluster_network_port',
	CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES: 'clustering_hubServer_cluster_network_routes',
	CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT: 'clustering_hubServer_leafNodes_network_port',
	CLUSTERING_HUBSERVER_NETWORK_PORT: 'clustering_hubServer_network_port',
	CLUSTERING_LEAFSERVER_NETWORK_PORT: 'clustering_leafServer_network_port',
	CLUSTERING_LEAFSERVER_NETWORK_ROUTES: 'clustering_leafServer_network_routes',
	CLUSTERING_LEAFSERVER_STREAMS_MAXAGE: 'clustering_leafServer_streams_maxAge',
	CLUSTERING_LEAFSERVER_STREAMS_MAXBYTES: 'clustering_leafServer_streams_maxBytes',
	CLUSTERING_LEAFSERVER_STREAMS_MAXMSGS: 'clustering_leafServer_streams_maxMsgs',
	CLUSTERING_NODENAME: 'clustering_nodeName',
	CLUSTERING_TLS_CERTIFICATE: 'clustering_tls_certificate',
	CLUSTERING_TLS_PRIVATEKEY: 'clustering_tls_privateKey',
	CLUSTERING_TLS_CERT_AUTH: 'clustering_tls_certificateAuthority',
	CLUSTERING_TLS_INSECURE: 'clustering_tls_insecure',
	CUSTOMFUNCTIONS_ENABLED: 'customFunctions_enabled',
	CUSTOMFUNCTIONS_NETWORK_PORT: 'customFunctions_network_port',
	CUSTOMFUNCTIONS_TLS_CERTIFICATE: 'customFunctions_tls_certificate',
	CUSTOMFUNCTIONS_NETWORK_CORS: 'customFunctions_network_cors',
	CUSTOMFUNCTIONS_NETWORK_CORSACCESSLIST: 'customFunctions_network_corsAccessList',
	CUSTOMFUNCTIONS_NETWORK_HEADERSTIMEOUT: 'customFunctions_network_headersTimeout',
	CUSTOMFUNCTIONS_NETWORK_HTTPS: 'customFunctions_network_https',
	CUSTOMFUNCTIONS_NETWORK_KEEPALIVETIMEOUT: 'customFunctions_network_keepAliveTimeout',
	CUSTOMFUNCTIONS_TLS_PRIVATEKEY: 'customFunctions_tls_privateKey',
	CUSTOMFUNCTIONS_TLS_CERT_AUTH: 'customFunctions_tls_certificateAuthority',
	CUSTOMFUNCTIONS_NETWORK_TIMEOUT: 'customFunctions_network_timeout',
	CUSTOMFUNCTIONS_NODEENV: 'customFunctions_nodeEnv',
	CUSTOMFUNCTIONS_ROOT: 'customFunctions_root',
	HTTP_THREADS: 'http_threads',
	HTTP_REMOTE_ADDRESS_AFFINITY: 'http_remoteAddressAffinity',
	IPC_NETWORK_PORT: 'ipc_network_port',
	LOCALSTUDIO_ENABLED: 'localStudio_enabled',
	LOGGING_FILE: 'logging_file',
	LOGGING_LEVEL: 'logging_level',
	LOGGING_ROOT: 'logging_root',
	LOGGING_ROTATION_COMPRESS: 'logging_rotation_compress',
	LOGGING_ROTATION_DATEFORMAT: 'logging_rotation_dateFormat',
	LOGGING_ROTATION_MAXSIZE: 'logging_rotation_maxSize',
	LOGGING_ROTATION_RETAIN: 'logging_rotation_retain',
	LOGGING_ROTATION_ROTATE: 'logging_rotation_rotate',
	LOGGING_ROTATION_ROTATEINTERVAL: 'logging_rotation_rotateInterval',
	LOGGING_ROTATION_ROTATEMODULE: 'logging_rotation_rotateModule',
	LOGGING_ROTATION_TIMEZONE: 'logging_rotation_timezone',
	LOGGING_ROTATION_WORKERINTERVAL: 'logging_rotation_workerInterval',
	LOGGING_STDSTREAMS: 'logging_stdStreams',
	LOGGING_AUDITLOG: 'logging_auditLog',
	OPERATIONSAPI_AUTHENTICATION_OPERATIONTOKENTIMEOUT: 'operationsApi_authentication_operationTokenTimeout',
	OPERATIONSAPI_AUTHENTICATION_REFRESHTOKENTIMEOUT: 'operationsApi_authentication_refreshTokenTimeout',
	OPERATIONSAPI_FOREGROUND: 'operationsApi_foreground',
	OPERATIONSAPI_TLS_CERTIFICATE: 'operationsApi_tls_certificate',
	OPERATIONSAPI_NETWORK_CORS: 'operationsApi_network_cors',
	OPERATIONSAPI_NETWORK_CORSACCESSLIST: 'operationsApi_network_corsAccessList',
	OPERATIONSAPI_NETWORK_HEADERSTIMEOUT: 'operationsApi_network_headersTimeout',
	OPERATIONSAPI_NETWORK_HTTPS: 'operationsApi_network_https',
	OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT: 'operationsApi_network_keepAliveTimeout',
	OPERATIONSAPI_NETWORK_PORT: 'operationsApi_network_port',
	OPERATIONSAPI_TLS_PRIVATEKEY: 'operationsApi_tls_privateKey',
	OPERATIONSAPI_TLS_CERT_AUTH: 'operationsApi_tls_certificateAuthority',
	OPERATIONSAPI_NETWORK_TIMEOUT: 'operationsApi_network_timeout',
	OPERATIONSAPI_NODEENV: 'operationsApi_nodeEnv',
	ROOTPATH: 'rootPath',
	STORAGE_WRITEASYNC: 'storage_writeAsync',
	STORAGE_OVERLAPPINGSYNC: 'storage_overlappingSync',
	STORAGE_CACHING: 'storage_caching',
	STORAGE_COMPRESSION: 'storage_compression',
	STORAGE_NOREADAHEAD: 'storage_noReadAhead',
	STORAGE_PREFETCHWRITES: 'storage_prefetchWrites',
};

// If a param is added to the config file it needs to be added here also. Keep all keys lowercase.
const CONFIG_PARAM_MAP = {
	hdb_root_key: CONFIG_PARAMS.ROOTPATH,
	hdb_root: CONFIG_PARAMS.ROOTPATH,
	server_port_key: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT,
	server_port: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT,
	cert_key: CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATE,
	certificate: CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATE,
	private_key_key: CONFIG_PARAMS.OPERATIONSAPI_TLS_PRIVATEKEY,
	private_key: CONFIG_PARAMS.OPERATIONSAPI_TLS_PRIVATEKEY,
	http_secure_enabled_key: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_HTTPS,
	https_on: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_HTTPS,
	cors_enabled_key: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORS,
	cors_on: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORS,
	cors_whitelist_key: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST,
	cors_whitelist: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST,
	cors_accesslist_key: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST,
	cors_accesslist: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST,
	log_level_key: CONFIG_PARAMS.LOGGING_LEVEL,
	log_level: CONFIG_PARAMS.LOGGING_LEVEL,
	log_path_key: CONFIG_PARAMS.LOGGING_ROOT,
	log_path: CONFIG_PARAMS.LOGGING_ROOT,
	log_daily_rotate: CONFIG_PARAMS.LOGGING_ROTATION_ROTATE,
	log_rotate: CONFIG_PARAMS.LOGGING_ROTATION_ROTATE,
	log_rotate_max_size: CONFIG_PARAMS.LOGGING_ROTATION_MAXSIZE,
	log_rotate_retain: CONFIG_PARAMS.LOGGING_ROTATION_RETAIN,
	log_rotate_compress: CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS,
	log_rotate_date_format: CONFIG_PARAMS.LOGGING_ROTATION_DATEFORMAT,
	log_rotate_rotate_module: CONFIG_PARAMS.LOGGING_ROTATION_ROTATEMODULE,
	log_rotate_worker_interval: CONFIG_PARAMS.LOGGING_ROTATION_WORKERINTERVAL,
	log_rotate_rotate_interval: CONFIG_PARAMS.LOGGING_ROTATION_ROTATEINTERVAL,
	log_rotate_timezone: CONFIG_PARAMS.LOGGING_ROTATION_TIMEZONE,
	props_env_key: CONFIG_PARAMS.OPERATIONSAPI_NODEENV,
	node_env: CONFIG_PARAMS.OPERATIONSAPI_NODEENV,
	clustering_node_name_key: CONFIG_PARAMS.CLUSTERING_NODENAME,
	node_name: CONFIG_PARAMS.CLUSTERING_NODENAME,
	clustering_enabled_key: CONFIG_PARAMS.CLUSTERING_ENABLED,
	clustering: CONFIG_PARAMS.CLUSTERING_ENABLED,
	max_http_threads: CONFIG_PARAMS.HTTP_THREADS,
	max_hdb_processes: CONFIG_PARAMS.HTTP_THREADS,
	http_remote_address_affinity: CONFIG_PARAMS.HTTP_REMOTE_ADDRESS_AFFINITY,
	server_timeout_key: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_TIMEOUT,
	server_timeout_ms: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_TIMEOUT,
	server_keep_alive_timeout_key: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT,
	server_keep_alive_timeout: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT,
	server_headers_timeout_key: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_HEADERSTIMEOUT,
	server_headers_timeout: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_HEADERSTIMEOUT,
	disable_transaction_log_key: CONFIG_PARAMS.LOGGING_AUDITLOG,
	disable_transaction_log: CONFIG_PARAMS.LOGGING_AUDITLOG,
	operation_token_timeout_key: CONFIG_PARAMS.OPERATIONSAPI_AUTHENTICATION_OPERATIONTOKENTIMEOUT,
	operation_token_timeout: CONFIG_PARAMS.OPERATIONSAPI_AUTHENTICATION_OPERATIONTOKENTIMEOUT,
	refresh_token_timeout_key: CONFIG_PARAMS.OPERATIONSAPI_AUTHENTICATION_REFRESHTOKENTIMEOUT,
	refresh_token_timeout: CONFIG_PARAMS.OPERATIONSAPI_AUTHENTICATION_REFRESHTOKENTIMEOUT,
	ipc_server_port: CONFIG_PARAMS.IPC_NETWORK_PORT,
	custom_functions_enabled_key: CONFIG_PARAMS.CUSTOMFUNCTIONS_ENABLED,
	custom_functions: CONFIG_PARAMS.CUSTOMFUNCTIONS_ENABLED,
	custom_functions_port_key: CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_PORT,
	custom_functions_port: CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_PORT,
	custom_functions_directory_key: CONFIG_PARAMS.CUSTOMFUNCTIONS_ROOT,
	custom_functions_directory: CONFIG_PARAMS.CUSTOMFUNCTIONS_ROOT,
	max_custom_function_processes: CONFIG_PARAMS.HTTP_THREADS,
	log_to_file: CONFIG_PARAMS.LOGGING_FILE,
	log_to_stdstreams: CONFIG_PARAMS.LOGGING_STDSTREAMS,
	run_in_foreground: CONFIG_PARAMS.OPERATIONSAPI_FOREGROUND,
	local_studio_on: CONFIG_PARAMS.LOCALSTUDIO_ENABLED,
	clustering_port: CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT,
	clustering_user: CONFIG_PARAMS.CLUSTERING_USER,
	clustering_enabled: CONFIG_PARAMS.CLUSTERING_ENABLED,
	clustering_hubserver_cluster_name: CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NAME,
	clustering_hubserver_cluster_network_port: CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT,
	clustering_hubserver_cluster_network_routes: CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_ROUTES,
	clustering_hubserver_leafnodes_network_port: CONFIG_PARAMS.CLUSTERING_HUBSERVER_LEAFNODES_NETWORK_PORT,
	clustering_hubserver_network_port: CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT,
	clustering_leafserver_network_port: CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT,
	clustering_leafserver_network_routes: CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_ROUTES,
	clustering_leafserver_streams_maxage: CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXAGE,
	clustering_leafserver_streams_maxbytes: CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXBYTES,
	clustering_leafserver_streams_maxmsgs: CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXMSGS,
	clustering_nodename: CONFIG_PARAMS.CLUSTERING_NODENAME,
	clustering_tls_certificate: CONFIG_PARAMS.CLUSTERING_TLS_CERTIFICATE,
	clustering_tls_privatekey: CONFIG_PARAMS.CLUSTERING_TLS_PRIVATEKEY,
	clustering_tls_certificateauthority: CONFIG_PARAMS.CLUSTERING_TLS_CERT_AUTH,
	clustering_tls_insecure: CONFIG_PARAMS.CLUSTERING_TLS_INSECURE,
	customfunctions_enabled: CONFIG_PARAMS.CUSTOMFUNCTIONS_ENABLED,
	customfunctions_network_port: CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_PORT,
	customfunctions_tls_certificate: CONFIG_PARAMS.CUSTOMFUNCTIONS_TLS_CERTIFICATE,
	customfunctions_network_cors: CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_CORS,
	customfunctions_network_corsaccesslist: CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_CORSACCESSLIST,
	customfunctions_network_headerstimeout: CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HEADERSTIMEOUT,
	customfunctions_network_https: CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HTTPS,
	customfunctions_network_keepalivetimeout: CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_KEEPALIVETIMEOUT,
	customfunctions_tls_privatekey: CONFIG_PARAMS.CUSTOMFUNCTIONS_TLS_PRIVATEKEY,
	customfunctions_tls_certificateauthority: CONFIG_PARAMS.CUSTOMFUNCTIONS_TLS_CERT_AUTH,
	customfunctions_network_timeout: CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_TIMEOUT,
	customfunctions_nodeenv: CONFIG_PARAMS.CUSTOMFUNCTIONS_NODEENV,
	http_threads: CONFIG_PARAMS.HTTP_THREADS,
	http_remote_address_affinity: CONFIG_PARAMS.HTTP_REMOTE_ADDRESS_AFFINITY,
	customfunctions_processes: CONFIG_PARAMS.HTTP_THREADS,
	customfunctions_root: CONFIG_PARAMS.CUSTOMFUNCTIONS_ROOT,
	ipc_network_port: CONFIG_PARAMS.IPC_NETWORK_PORT,
	localstudio_enabled: CONFIG_PARAMS.LOCALSTUDIO_ENABLED,
	logging_file: CONFIG_PARAMS.LOGGING_FILE,
	logging_level: CONFIG_PARAMS.LOGGING_LEVEL,
	logging_root: CONFIG_PARAMS.LOGGING_ROOT,
	logging_rotation_compress: CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS,
	logging_rotation_dateformat: CONFIG_PARAMS.LOGGING_ROTATION_DATEFORMAT,
	logging_rotation_maxsize: CONFIG_PARAMS.LOGGING_ROTATION_MAXSIZE,
	logging_rotation_retain: CONFIG_PARAMS.LOGGING_ROTATION_RETAIN,
	logging_rotation_rotate: CONFIG_PARAMS.LOGGING_ROTATION_ROTATE,
	logging_rotation_rotateinterval: CONFIG_PARAMS.LOGGING_ROTATION_ROTATEINTERVAL,
	logging_rotation_rotatemodule: CONFIG_PARAMS.LOGGING_ROTATION_ROTATEMODULE,
	logging_rotation_timezone: CONFIG_PARAMS.LOGGING_ROTATION_TIMEZONE,
	logging_rotation_workerinterval: CONFIG_PARAMS.LOGGING_ROTATION_WORKERINTERVAL,
	logging_stdstreams: CONFIG_PARAMS.LOGGING_STDSTREAMS,
	logging_auditlog: CONFIG_PARAMS.LOGGING_AUDITLOG,
	operationsapi_authentication_operationtokentimeout: CONFIG_PARAMS.OPERATIONSAPI_AUTHENTICATION_OPERATIONTOKENTIMEOUT,
	operationsapi_authentication_refreshtokentimeout: CONFIG_PARAMS.OPERATIONSAPI_AUTHENTICATION_REFRESHTOKENTIMEOUT,
	operationsapi_foreground: CONFIG_PARAMS.OPERATIONSAPI_FOREGROUND,
	operationsapi_tls_certificate: CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATE,
	operationsapi_network_cors: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORS,
	operationsapi_network_corsaccesslist: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST,
	operationsapi_network_headerstimeout: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_HEADERSTIMEOUT,
	operationsapi_network_https: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_HTTPS,
	operationsapi_network_keepalivetimeout: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT,
	operationsapi_network_port: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT,
	operationsapi_tls_privatekey: CONFIG_PARAMS.OPERATIONSAPI_TLS_PRIVATEKEY,
	operationsapi_network_timeout: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_TIMEOUT,
	operationsapi_nodeenv: CONFIG_PARAMS.OPERATIONSAPI_NODEENV,
	operationsapi_root: CONFIG_PARAMS.ROOTPATH,
	rootpath: CONFIG_PARAMS.ROOTPATH,
	storage_writeasync: CONFIG_PARAMS.STORAGE_WRITEASYNC,
	storage_overlappingsync: CONFIG_PARAMS.STORAGE_OVERLAPPINGSYNC,
	storage_noreadahead: CONFIG_PARAMS.STORAGE_NOREADAHEAD,
	storage_caching: CONFIG_PARAMS.STORAGE_CACHING,
	storage_compression: CONFIG_PARAMS.STORAGE_COMPRESSION,
	storage_prefetchwrites: CONFIG_PARAMS.STORAGE_PREFETCHWRITES,
};

// Describes all available job types
const JOB_TYPE_ENUM = {
	csv_file_load: 'csv_file_load',
	csv_data_load: OPERATIONS_ENUM.CSV_DATA_LOAD,
	csv_url_load: OPERATIONS_ENUM.CSV_URL_LOAD,
	delete_files_before: 'delete_files_before',
	delete_records_before: 'delete_records_before',
	delete_audit_logs_before: 'delete_audit_logs_before',
	delete_transaction_logs_before: 'delete_transaction_logs_before',
	empty_trash: 'empty_trash',
	export_local: 'export_local',
	export_to_s3: 'export_to_s3',
	import_from_s3: 'import_from_s3',
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
	RESTART: 'restart',
};
const CLUSTER_CONNECTION_DIRECTION_ENUM = {
	// Data flows to both the client and this server
	BIDIRECTIONAL: 'BIDIRECTIONAL',
	// This server only sends data to its client, it doesn't up update from received data
	OUTBOUND: 'OUTBOUND',
	// This server only receives data, it does not send updated data
	INBOUND: 'INBOUND',
};

const STORAGE_TYPES_ENUM = {
	FILE_SYSTEM: 'fs',
	LMDB: 'lmdb',
};

const LICENSE_VALUES = {
	API_CALL_DEFAULT: 10000,
	VERSION_DEFAULT: '2.2.0',
};

// The maximum ram allocation in MB per HDB child process
const RAM_ALLOCATION_ENUM = {
	DEVELOPMENT: 8192, //8GB
	DEFAULT: 512, //.5GB
};

const CLUSTER_EVENTS_DEFS_ENUM = {
	IDENTIFY: 'identify',
	AUTHENTICATE: 'authenticate',
	AUTHENTICATE_OK: 'authenticated',
	AUTHENTICATE_FAIL: 'authenticate_fail',
	CONNECTION: 'connection',
	CONNECT: 'connect',
	CATCHUP_REQUEST: 'catchup_request',
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
	DIRECTION_CHANGE: 'direction_change',
};

const WEBSOCKET_CLOSE_CODE_DESCRIPTION_LOOKUP = {
	1000: 'SUCCESSFUL_SHUTDOWN',
	1001: 'CLOSE_GOING_AWAY',
	1002: 'CLOSE_PROTOCOL_ERROR',
	1003: 'CLOSE_UNSUPPORTED',
	1005: 'CLOSE_NO_STATUS',
	1006: 'CLOSE_ABNORMAL',
	1007: 'UNSUPPORTED_PAYLOAD',
	1008: 'POLICY_VIOLATION',
	1009: 'CLOSE_TOO_LARGE',
	1010: 'MANDATORY_EXTENSION',
	1011: 'SERVER_ERROR',
	1012: 'SERVICE_RESTART',
	1013: 'SERVER_BUSY',
	1014: 'BAD_GATEWAY',
	1015: 'HANDSHAKE_FAIL',
	4141: 'LICENSE_LIMIT_REACHED',
};

const NODE_ERROR_CODES = {
	ENOENT: 'ENOENT', // No such file or directory.
	EACCES: 'EACCES', // Permission denied.
};

const TIME_STAMP_NAMES_ENUM = {
	CREATED_TIME: '__createdtime__',
	UPDATED_TIME: '__updatedtime__',
};
const CLUSTERING_FLAG = '__clustering__';

const TIME_STAMP_NAMES = Object.values(TIME_STAMP_NAMES_ENUM);

//This value is used to help evaluate whether or not a permissions translation error is related to old permissions values
// or if it could be another code-related bug/error.
const PERMS_UPDATE_RELEASE_TIMESTAMP = 1598486400000;

const VALUE_SEARCH_COMPARATORS = {
	LESS: '<',
	LESS_OR_EQ: '<=',
	GREATER: '>',
	GREATER_OR_EQ: '>=',
	BETWEEN: '...',
};
const VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP = _.invert(VALUE_SEARCH_COMPARATORS);

// Message types that will flow through the HDB Child and Cluster rooms.
const CLUSTERING_MESSAGE_TYPES = {
	GET_CLUSTER_STATUS: 'GET_CLUSTER_STATUS',
	CLUSTER_STATUS_RESPONSE: 'CLUSTER_STATUS_RESPONSE',
	ERROR_RESPONSE: 'ERROR',
	ADD_USER: 'ADD_USER',
	ALTER_USER: 'ALTER_USER',
	DROP_USER: 'DROP_USER',
	HDB_OPERATION: 'HDB_OPERATION',
	ADD_NODE: 'ADD_NODE',
	UPDATE_NODE: 'UPDATE_NODE',
	REMOVE_NODE: 'REMOVE_NODE',
	HDB_USERS_MSG: 'HDB_USERS_MSG',
	HDB_WORKERS: 'HDB_WORKERS',
	HDB_TRANSACTION: 'HDB_TRANSACTION',
};

const ORIGINATOR_SET_VALUE = 111;
const NEW_LINE = '\r\n';

const PERMS_CRUD_ENUM = {
	READ: 'read',
	INSERT: 'insert',
	UPDATE: 'update',
	DELETE: 'delete',
};

const SEARCH_WILDCARDS = ['*', '%'];

const UNAUTHORIZED_PERMISSION_NAME = 'unauthorized_access';

const FUNC_VAL = 'func_val';

const READ_AUDIT_LOG_SEARCH_TYPES_ENUM = {
	HASH_VALUE: 'hash_value',
	TIMESTAMP: 'timestamp',
	USERNAME: 'username',
};

const JWT_ENUM = {
	JWT_PRIVATE_KEY_NAME: '.jwtPrivate.key',
	JWT_PUBLIC_KEY_NAME: '.jwtPublic.key',
	JWT_PASSPHRASE_NAME: '.jwtPass',
};

const HDB_IPC_SERVER = 'hdb_ipc_server';
const HDB_IPC_CLIENT_PREFIX = 'hdb_ipc_client_';
const IPC_EVENT_TYPES = {
	ADD_PORT: 'add-port',
	RESTART: 'restart',
	CHILD_STARTED: 'child_started',
	CHILD_STOPPED: 'child_stopped',
	SCHEMA: 'schema',
	USER: 'user',
	CLUSTER_STATUS_RESPONSE: 'cluster_status_response',
	CLUSTER_STATUS_REQUEST: 'cluster_status_request',
	METRICS: 'metrics',
	GET_METRICS: 'get_metrics',
};

const SERVICES = {
	HDB_CORE: 'hdb_core',
	CUSTOM_FUNCTIONS: 'custom_functions',
};

const PM2_PROCESS_STATUSES = {
	STOPPED: 'stopped',
	ONLINE: 'online',
};

const PRE_4_0_0_VERSION = '3.x.x';

module.exports = {
	LOCAL_HARPERDB_OPERATIONS,
	HDB_SUPPORT_ADDRESS,
	HDB_SUPPORT_URL,
	HDB_PRICING_URL,
	SUPPORT_HELP_MSG,
	LICENSE_HELP_MSG,
	HDB_PROC_NAME,
	HDB_PROC_DESCRIPTOR,
	CLUSTERING_LEAF_PROC_DESCRIPTOR,
	CLUSTERING_HUB_PROC_DESCRIPTOR,
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
	VALID_S3_FILE_TYPES,
	S3_BUCKET_AUTH_KEYS,
	VALID_SQL_OPS_ENUM,
	GEO_CONVERSION_ENUM,
	HDB_SETTINGS_NAMES,
	HDB_SETTINGS_NAMES_REVERSE_LOOKUP,
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
	ORIGINATOR_SET_VALUE,
	LICENSE_VALUES,
	RAM_ALLOCATION_ENUM,
	STORAGE_TYPES_ENUM,
	TIME_STAMP_NAMES_ENUM,
	TIME_STAMP_NAMES,
	PERMS_UPDATE_RELEASE_TIMESTAMP,
	SEARCH_NOT_FOUND_MESSAGE,
	SEARCH_ATTRIBUTE_NOT_FOUND,
	LICENSE_ROLE_DENIED_RESPONSE,
	LICENSE_MAX_CONNS_REACHED,
	BASIC_LICENSE_MAX_NON_CU_ROLES,
	BASIC_LICENSE_CLUSTER_CONNECTION_LIMIT_WS_ERROR_CODE,
	VALUE_SEARCH_COMPARATORS,
	VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP,
	LICENSE_FILE_NAME,
	WEBSOCKET_CLOSE_CODE_DESCRIPTION_LOOKUP,
	NEW_LINE,
	BASIC_LICENSE_MAX_CLUSTER_USER_ROLES,
	MOMENT_DAYS_TAG,
	API_TURNOVER_SEC,
	LOOPBACK,
	CODE_EXTENSION,
	WILDCARD_SEARCH_VALUE,
	NODE_ERROR_CODES,
	JAVASCRIPT_EXTENSION,
	PERMS_CRUD_ENUM,
	UNAUTHORIZED_PERMISSION_NAME,
	SEARCH_WILDCARDS,
	FUNC_VAL,
	READ_AUDIT_LOG_SEARCH_TYPES_ENUM,
	JWT_ENUM,
	CLUSTERING_FLAG,
	RUN_LOG,
	INSTALL_LOG,
	IPC_SERVER_MODULE,
	HDB_IPC_SERVER,
	IPC_EVENT_TYPES,
	HDB_IPC_CLIENT_PREFIX,
	CUSTOM_FUNCTION_PROC_NAME,
	CUSTOM_FUNCTION_PROC_DESCRIPTOR,
	SERVICES,
	MEM_SETTING_KEY,
	HDB_RESTART_SCRIPT,
	PROCESS_DESCRIPTORS,
	SERVICE_SERVERS,
	SERVICE_SERVERS_CWD,
	PROCESS_DESCRIPTORS_VALIDATE,
	LAUNCH_SERVICE_SCRIPTS,
	LOG_LEVELS,
	PROCESS_NAME_ENV_PROP,
	PROCESS_LOG_NAMES,
	PM2_PROCESS_STATUSES,
	CONFIG_PARAM_MAP,
	CONFIG_PARAMS,
	HDB_CONFIG_FILE,
	HDB_DEFAULT_CONFIG_FILE,
	ROLE_TYPES_ENUM,
	BOOT_PROP_PARAMS,
	INSTALL_PROMPTS,
	HDB_ROOT_DIR_NAME,
	CLUSTERING_PROCESSES,
	FOREGROUND_PID_FILE,
	PACKAGE_ROOT,
	PRE_4_0_0_VERSION,
};
