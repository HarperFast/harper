import { join as hdbTerms } from 'node:path';
import { PACKAGE_ROOT } from './packageUtils.js';

/**
 * This module contains common variables/values that will be used across the project.
 * Using these constant values helps with consistency across the project.
 *
 * All variables should use a JSDoc comment to explain what it is, and any objects should be marked as `as const` for better type checking.
 */

/** HarperDB Root Config File */
export const HDB_CONFIG_FILE = 'harperdb-config.yaml';
/** HarperDB Default Config File */
export const HDB_DEFAULT_CONFIG_FILE = 'defaultConfig.yaml';
/** HarperDB Root Directory Name */
export const HDB_ROOT_DIR_NAME = 'hdb';
/** HarperDB Component Config File */
export const HDB_COMPONENT_CONFIG_FILE = 'config.yaml';

/** Name of the HarperDB Process Script */
export const HDB_PROC_NAME = 'harperdb.js';
/** Name of the HarperDB Restart Script */
export const HDB_RESTART_SCRIPT = 'restartHdb.js';

/** HarperDB Process Descriptor */
const HDB_PROC_DESCRIPTOR = 'HarperDB';
/** Custom Function Process Descriptor */
const CUSTOM_FUNCTION_PROC_DESCRIPTOR = 'Custom Functions';
/** Clustering Hub Process Descriptor */
const CLUSTERING_HUB_PROC_DESCRIPTOR = 'Clustering Hub';
/** Clustering Leaf Process Descriptor */
const CLUSTERING_LEAF_PROC_DESCRIPTOR = 'Clustering Leaf';
/** Clustering Ingest Service Process Descriptor */
const CLUSTERING_INGEST_PROC_DESCRIPTOR = 'Clustering Ingest Service';
/** Clustering Reply Service Process Descriptor */
const CLUSTERING_REPLY_SERVICE_DESCRIPTOR = 'Clustering Reply Service';

/**
 * Process Descriptor Map
 *
 * Used throughout the project to map process descriptors to their respective process names.
 */
export const PROCESS_DESCRIPTORS = {
	HDB: HDB_PROC_DESCRIPTOR,
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
	CLUSTERING_UPGRADE_4_0_0: 'Upgrade-4-0-0',
} as const;

/**
 * Process Services Map
 *
 * These are the services that the HarperDB process provides.
 * This object is used primarily in the restart workflow to determine which services to restart.
 */
export const HDB_PROCESS_SERVICES = {
	'harperdb': HDB_PROC_DESCRIPTOR,
	'clustering hub': CLUSTERING_HUB_PROC_DESCRIPTOR,
	'clustering leaf': CLUSTERING_LEAF_PROC_DESCRIPTOR,
	'custom functions': CUSTOM_FUNCTION_PROC_DESCRIPTOR,
	'custom_functions': CUSTOM_FUNCTION_PROC_DESCRIPTOR,
	'clustering': 'clustering',
	'clustering config': 'clustering config',
	'clustering_config': 'clustering_config',
	'http_workers': 'http_workers',
	'http': 'http',
} as const;

/**
 * Clustering Process Services Map
 *
 * Used for process management to easily iterate over the clustering processes.
 */
export const CLUSTERING_PROCESSES = {
	CLUSTERING_HUB_PROC_DESCRIPTOR,
	CLUSTERING_LEAF_PROC_DESCRIPTOR,
} as const;

/** HarperDB Process Identifier File Name */
export const HDB_PID_FILE = 'hdb.pid';
/** Default database name */
export const DEFAULT_DATABASE_NAME = 'data';

/** Log File Names */
export const LOG_NAMES = {
	HDB: 'hdb.log',
	INSTALL: 'install.log',
	CLUSTERING_HUB: 'clustering_hub.log',
	CLUSTERING_LEAF: 'clustering_leaf.log',
} as const;

/** Log Levels */
export const LOG_LEVELS = {
	NOTIFY: 'notify',
	FATAL: 'fatal',
	ERROR: 'error',
	WARN: 'warn',
	INFO: 'info',
	DEBUG: 'debug',
	TRACE: 'trace',
} as const;

/** Launch Service script paths */
export const LAUNCH_SERVICE_SCRIPTS = {
	MAIN: 'bin/harperdb.js',
	NATS_INGEST_SERVICE: hdbTerms(PACKAGE_ROOT, 'launchServiceScripts/launchNatsIngestService.js'),
	NATS_REPLY_SERVICE: hdbTerms(PACKAGE_ROOT, 'launchServiceScripts/launchNatsReplyService.js'),
	NODES_UPGRADE_4_0_0: hdbTerms(PACKAGE_ROOT, 'launchServiceScripts/launchUpdateNodes4-0-0.js'),
} as const;

/** Specifies user role types */
export const ROLE_TYPES_ENUM = {
	SUPER_USER: 'super_user',
	CLUSTER_USER: 'cluster_user',
} as const;

/** Email address for support requests */
export const HDB_SUPPORT_ADDRESS = 'support@harperdb.io';

/** Support Help Message */
export const SUPPORT_HELP_MSG = `For support, please submit a request at https://harperdbhelp.zendesk.com/hc/en-us/requests/new or contact ${HDB_SUPPORT_ADDRESS}`;
/** Message when records cannot be found for a DELETE operation */
export const SEARCH_NOT_FOUND_MESSAGE = 'None of the specified records were found.';

// TODO: The following unicode/regex terms seem pointless, and could be removed.
// Singular character codes and basic regex patterns should be included inline where they are used.
// These are not likely to ever change and don't need to be extrapolated into variables

/** Unicode for the `.` character */
export const UNICODE_PERIOD = 'U+002E';
/** Regex for matching the `/` character */
export const FORWARD_SLASH_REGEX = /\//g;
/** Unicode for the `/` character */
export const UNICODE_FORWARD_SLASH = 'U+002F';
/** Regex for matching an escaped `/` character */
export const ESCAPED_FORWARD_SLASH_REGEX = /U\+002F/g;

/** CLI Argument for setting the memory value */
export const MEM_SETTING_KEY = '--max-old-space-size=';

/** Name of the System schema */
export const SYSTEM_SCHEMA_NAME = 'system';

/** HarperDB Home directory */
export const HDB_HOME_DIR_NAME = '.harperdb';

/** License Key directory */
export const LICENSE_KEY_DIR_NAME = 'keys';

/** HarperDB Boot Properties file name */
export const BOOT_PROPS_FILE_NAME = 'hdb_boot_properties.file';

/** Restart timeout (milliseconds) */
export const RESTART_TIMEOUT_MS = 60000;

/** HarperDB File Permissions Mode */
export const HDB_FILE_PERMISSIONS = 0o700;

/** Database directory */
export const DATABASES_DIR_NAME = 'database';
/** Legacy Database directory */
export const LEGACY_DATABASES_DIR_NAME = 'schema';
/** Transaction directory */
export const TRANSACTIONS_DIR_NAME = 'transactions';

/** Key for specifying process specific environment variables */
export const PROCESS_NAME_ENV_PROP = 'PROCESS_NAME';

/** Boot sequence property parameters */
export const BOOT_PROP_PARAMS = {
	SETTINGS_PATH_KEY: 'settings_path',
} as const;

/** Installation prompt map */
export const INSTALL_PROMPTS = {
	TC_AGREEMENT: 'TC_AGREEMENT',
	CLUSTERING_USER: 'CLUSTERING_USER',
	CLUSTERING_PASSWORD: 'CLUSTERING_PASSWORD',
	HDB_ADMIN_USERNAME: 'HDB_ADMIN_USERNAME',
	HDB_ADMIN_PASSWORD: 'HDB_ADMIN_PASSWORD',
	OPERATIONSAPI_ROOT: 'OPERATIONSAPI_ROOT',
	ROOTPATH: 'ROOTPATH',
	CLUSTERING_NODENAME: 'CLUSTERING_NODENAME',
	CLUSTERING_ENABLED: 'CLUSTERING_ENABLED',
	HDB_CONFIG: 'HDB_CONFIG',
	DEFAULTS_MODE: 'DEFAULTS_MODE',
	REPLICATION_HOSTNAME: 'REPLICATION_HOSTNAME',
	// Prompts below are pre 4.0.0 release
	CLUSTERING_PORT: 'CLUSTERING_PORT',
	HDB_ROOT: 'HDB_ROOT',
	SERVER_PORT: 'SERVER_PORT',
	NODE_NAME: 'NODE_NAME',
	CLUSTERING: 'CLUSTERING',
} as const;

/** Insert operation max character size */
export const INSERT_MAX_CHARACTER_SIZE = 250;

/** Upgrade JSON field map */
export const UPGRADE_JSON_FIELD_NAMES_ENUM = {
	DATA_VERSION: 'data_version',
	UPGRADE_VERSION: 'upgrade_version',
} as const;

/** System table names */
export const SYSTEM_TABLE_NAMES = {
	JOB_TABLE_NAME: 'hdb_job',
	NODE_TABLE_NAME: 'hdb_nodes',
	ATTRIBUTE_TABLE_NAME: 'hdb_attribute',
	LICENSE_TABLE_NAME: 'hdb_license',
	ROLE_TABLE_NAME: 'hdb_role',
	SCHEMA_TABLE_NAME: 'hdb_schema',
	TABLE_TABLE_NAME: 'hdb_table',
	USER_TABLE_NAME: 'hdb_user',
	INFO_TABLE_NAME: 'hdb_info',
} as const;

/** Hash attribute for the system info table */
export const INFO_TABLE_HASH_ATTRIBUTE = 'info_id';

/** System default attributes */
export const SYSTEM_DEFAULT_ATTRIBUTE_NAMES = {
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
} as const;

/** Registration key file name */
export const REG_KEY_FILE_NAME = '060493.ks';

/** License file name */
export const LICENSE_FILE_NAME = '.license';

/** Describes the available statuses for jobs */
export const JOB_STATUS_ENUM = {
	CREATED: 'CREATED',
	IN_PROGRESS: 'IN_PROGRESS',
	COMPLETE: 'COMPLETE',
	ERROR: 'ERROR',
} as const;

/** Operations */
export const OPERATIONS_ENUM = {
	INSERT: 'insert',
	UPDATE: 'update',
	UPSERT: 'upsert',
	SEARCH_BY_CONDITIONS: 'search_by_conditions',
	SEARCH_BY_HASH: 'search_by_hash',
	SEARCH_BY_ID: 'search_by_id',
	SEARCH_BY_VALUE: 'search_by_value',
	SEARCH: 'search',
	SQL: 'sql',
	CSV_DATA_LOAD: 'csv_data_load',
	CSV_FILE_LOAD: 'csv_file_load',
	CSV_URL_LOAD: 'csv_url_load',
	CREATE_SCHEMA: 'create_schema',
	CREATE_DATABASE: 'create_database',
	CREATE_TABLE: 'create_table',
	CREATE_ATTRIBUTE: 'create_attribute',
	DROP_SCHEMA: 'drop_schema',
	DROP_DATABASE: 'drop_database',
	DROP_TABLE: 'drop_table',
	DESCRIBE_SCHEMA: 'describe_schema',
	DESCRIBE_DATABASE: 'describe_database',
	DESCRIBE_TABLE: 'describe_table',
	DESCRIBE_ALL: 'describe_all',
	DESCRIBE_METRIC: 'describe_metric',
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
	SET_NODE_REPLICATION: 'set_node_replication',
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
	CLUSTER_NETWORK: 'cluster_network',
	DROP_ATTRIBUTE: 'drop_attribute',
	REMOVE_NODE: 'remove_node',
	RESTART: 'restart',
	RESTART_SERVICE: 'restart_service',
	CATCHUP: 'catchup',
	SYSTEM_INFORMATION: 'system_information',
	DELETE_AUDIT_LOGS_BEFORE: 'delete_audit_logs_before',
	READ_AUDIT_LOG: 'read_audit_log',
	CREATE_AUTHENTICATION_TOKENS: 'create_authentication_tokens',
	LOGIN: 'login',
	LOGOUT: 'logout',
	REFRESH_OPERATION_TOKEN: 'refresh_operation_token',
	GET_CONFIGURATION: 'get_configuration',
	CUSTOM_FUNCTIONS_STATUS: 'custom_functions_status',
	GET_CUSTOM_FUNCTIONS: 'get_custom_functions',
	GET_CUSTOM_FUNCTION: 'get_custom_function',
	SET_CUSTOM_FUNCTION: 'set_custom_function',
	GET_COMPONENTS: 'get_components',
	GET_COMPONENT_FILE: 'get_component_file',
	SET_COMPONENT_FILE: 'set_component_file',
	DROP_COMPONENT: 'drop_component',
	DROP_CUSTOM_FUNCTION: 'drop_custom_function',
	ADD_CUSTOM_FUNCTION_PROJECT: 'add_custom_function_project',
	ADD_COMPONENT: 'add_component',
	DROP_CUSTOM_FUNCTION_PROJECT: 'drop_custom_function_project',
	PACKAGE_CUSTOM_FUNCTION_PROJECT: 'package_custom_function_project',
	DEPLOY_CUSTOM_FUNCTION_PROJECT: 'deploy_custom_function_project',
	PACKAGE_COMPONENT: 'package_component',
	DEPLOY_COMPONENT: 'deploy_component',
	CLUSTER_SET_ROUTES: 'cluster_set_routes',
	CLUSTER_DELETE_ROUTES: 'cluster_delete_routes',
	CLUSTER_GET_ROUTES: 'cluster_get_routes',
	READ_TRANSACTION_LOG: 'read_transaction_log',
	DELETE_TRANSACTION_LOGS_BEFORE: 'delete_transaction_logs_before',
	INSTALL_NODE_MODULES: 'install_node_modules',
	AUDIT_NODE_MODULES: 'audit_node_modules',
	PURGE_STREAM: 'purge_stream',
	GET_BACKUP: 'get_backup',
	SIGN_CERTIFICATE: 'sign_certificate',
	CREATE_CSR: 'create_csr',
	LIST_CERTIFICATES: 'list_certificates',
	ADD_CERTIFICATES: 'add_certificate',
	REMOVE_CERTIFICATE: 'remove_certificate',
	ADD_NODE_BACK: 'add_node_back',
	REMOVE_NODE_BACK: 'remove_node_back',
	ADD_SSH_KEY: 'add_ssh_key',
	UPDATE_SSH_KEY: 'update_ssh_key',
	DELETE_SSH_KEY: 'delete_ssh_key',
	LIST_SSH_KEYS: 'list_ssh_keys',
	SET_SSH_KNOWN_HOSTS: 'set_ssh_known_hosts',
	GET_SSH_KNOWN_HOSTS: 'get_ssh_known_hosts',
	GET_KEY: 'get_key',
	GET_ANALYTICS: 'get_analytics',
	LIST_METRICS: 'list_metrics',
	GET_STATUS: 'get_status',
	SET_STATUS: 'set_status',
	CLEAR_STATUS: 'clear_status',
} as const;

/** Defines valid file types that we are able to handle in 'import_from_s3' ops */
export const VALID_S3_FILE_TYPES = {
	CSV: '.csv',
	JSON: '.json',
} as const;

/** Defines the keys required in a request body for accessing a S3 bucket */
export const S3_BUCKET_AUTH_KEYS = {
	AWS_ACCESS_KEY: 'aws_access_key_id',
	AWS_SECRET: 'aws_secret_access_key',
	AWS_BUCKET: 'bucket',
	AWS_FILE_KEY: 'key',
	REGION: 'region',
} as const;

/**
 * Defines valid SQL operations to be used in the processAST method - this ensure we have appropriate unit test coverage
 * for all SQL operations that are dynamically set after the chooseOperation method which behaves differently for the evaluateSQL operation.
 */
export const VALID_SQL_OPS_ENUM = {
	SELECT: 'select',
	INSERT: 'insert',
	UPDATE: 'update',
	DELETE: 'delete',
} as const;

/** Defines operations that should be propagated to the cluster. */
export const CLUSTER_OPERATIONS = {
	[OPERATIONS_ENUM.INSERT]: OPERATIONS_ENUM.INSERT,
	[OPERATIONS_ENUM.UPDATE]: OPERATIONS_ENUM.UPDATE,
	[OPERATIONS_ENUM.UPSERT]: OPERATIONS_ENUM.UPSERT,
	[OPERATIONS_ENUM.DELETE]: OPERATIONS_ENUM.DELETE,
} as const;

/** Available service actions */
export const SERVICE_ACTIONS_ENUM = {
	DEV: 'dev',
	RUN: 'run',
	START: 'start',
	INSTALL: 'install',
	REGISTER: 'register',
	STOP: 'stop',
	RESTART: 'restart',
	VERSION: 'version',
	UPGRADE: 'upgrade',
	HELP: 'help',
	STATUS: 'status',
	OPERATION: 'operation',
	RENEWCERTS: 'renew-certs',
	COPYDB: 'copy-db',
} as const;

/** describes the Geo Conversion types */
export const GEO_CONVERSION_ENUM = {
	point: 'point',
	lineString: 'lineString',
	multiLineString: 'multiLineString',
	multiPoint: 'multiPoint',
	multiPolygon: 'multiPolygon',
	polygon: 'polygon',
} as const;

/**
 * These values are relics of before the config was converted to yaml.
 * The should no longer be used. Instead use CONFIG_PARAMS.
 */
export const HDB_SETTINGS_NAMES = {
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
	CUSTOM_FUNCTIONS_ENABLED_KEY: 'CUSTOM_FUNCTIONS',
	CUSTOM_FUNCTIONS_PORT_KEY: 'CUSTOM_FUNCTIONS_PORT',
	CUSTOM_FUNCTIONS_DIRECTORY_KEY: 'CUSTOM_FUNCTIONS_DIRECTORY',
	MAX_CUSTOM_FUNCTION_PROCESSES: 'MAX_CUSTOM_FUNCTION_PROCESSES',
	LOG_TO_FILE: 'LOG_TO_FILE',
	LOG_TO_STDSTREAMS: 'LOG_TO_STDSTREAMS',
	RUN_IN_FOREGROUND: 'RUN_IN_FOREGROUND',
	LOCAL_STUDIO_ON: 'LOCAL_STUDIO_ON',
	STORAGE_WRITE_ASYNC: 'STORAGE_WRITE_ASYNC',
} as const;

/** Legacy configuration parameters */
export const LEGACY_CONFIG_PARAMS = {
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
} as const;

/**
 * All configuration parameters for HarperDB
 *
 * If a param is added to config it must also be added here.
 */
export const CONFIG_PARAMS = {
	ANALYTICS_AGGREGATEPERIOD: 'analytics_aggregatePeriod',
	ANALYTICS_REPLICATE: 'analytics_replicate',
	AUTHENTICATION_AUTHORIZELOCAL: 'authentication_authorizeLocal',
	AUTHENTICATION_CACHETTL: 'authentication_cacheTTL',
	AUTHENTICATION_COOKIE_DOMAINS: 'authentication_cookie_domains',
	AUTHENTICATION_COOKIE_EXPIRES: 'authentication_cookie_expires',
	AUTHENTICATION_ENABLESESSIONS: 'authentication_enableSessions',
	AUTHENTICATION_OPERATIONTOKENTIMEOUT: 'authentication_operationTokenTimeout',
	AUTHENTICATION_REFRESHTOKENTIMEOUT: 'authentication_refreshTokenTimeout',
	AUTHENTICATION_HASHFUNCTION: 'authentication_hashFunction',
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
	CLUSTERING_LEAFSERVER_STREAMS_MAXCONSUMEMSGS: 'clustering_leafServer_streams_maxConsumeMsgs',
	CLUSTERING_LEAFSERVER_STREAMS_MAXINGESTTHREADS: 'clustering_leafServer_streams_maxIngestThreads',
	CLUSTERING_LEAFSERVER_STREAMS_PATH: 'clustering_leafServer_streams_path',
	CLUSTERING_NODENAME: 'clustering_nodeName',
	CLUSTERING_TLS_CERTIFICATE: 'clustering_tls_certificate',
	CLUSTERING_TLS_PRIVATEKEY: 'clustering_tls_privateKey',
	CLUSTERING_TLS_CERT_AUTH: 'clustering_tls_certificateAuthority',
	CLUSTERING_TLS_INSECURE: 'clustering_tls_insecure',
	CLUSTERING_TLS_VERIFY: 'clustering_tls_verify',
	CLUSTERING_LOGLEVEL: 'clustering_logLevel',
	CLUSTERING_REPUBLISHMESSAGES: 'clustering_republishMessages',
	CLUSTERING_DATABASELEVEL: 'clustering_databaseLevel',
	CUSTOMFUNCTIONS_NETWORK_HTTPS: 'customFunctions_network_https',
	THREADS: 'threads',
	THREADS_COUNT: 'threads_count',
	THREADS_DEBUG: 'threads_debug',
	THREADS_DEBUG_STARTINGPORT: 'threads_debug_startingPort',
	THREADS_DEBUG_PORT: 'threads_debug_port',
	THREADS_DEBUG_HOST: 'threads_debug_host',
	THREADS_DEBUG_WAITFORDEBUGGER: 'threads_debug_waitForDebugger',
	THREADS_MAXHEAPMEMORY: 'threads_maxHeapMemory',
	HTTP_SESSIONAFFINITY: 'http_sessionAffinity',
	HTTP_COMPRESSIONTHRESHOLD: 'http_compressionThreshold',
	HTTP_CORS: 'http_cors',
	HTTP_CORSACCESSLIST: 'http_corsAccessList',
	HTTP_CORSACCESSCONTROLALLOWHEADERS: 'http_corsAccessControlAllowHeaders',
	HTTP_HEADERSTIMEOUT: 'http_headersTimeout',
	HTTP_KEEPALIVETIMEOUT: 'http_keepAliveTimeout',
	HTTP_MAXPARAMLENGTH: 'http_maxParamLength',
	HTTP_TIMEOUT: 'http_timeout',
	HTTP_PORT: 'http_port',
	HTTP_SECUREPORT: 'http_securePort',
	HTTP_MTLS: 'http_mtls',
	HTTP_MTLS_REQUIRED: 'http_mtls_required',
	HTTP_MTLS_USER: 'http_mtls_user',
	HTTP_MAXHEADERSIZE: 'http_maxHeaderSize',
	HTTP_THREADRANGE: 'http_threadRange',
	HTTP_HTTP2: 'http_http2',
	LOCALSTUDIO_ENABLED: 'localStudio_enabled',
	LOGGING_CONSOLE: 'logging_console',
	LOGGING_FILE: 'logging_file',
	LOGGING_LEVEL: 'logging_level',
	LOGGING_ROOT: 'logging_root',
	LOGGING_EXTERNAL_LEVEL: 'logging_external_level',
	LOGGING_EXTERNAL_TAG: 'logging_external_tag',
	LOGGING_EXTERNAL_PATH: 'logging_external_path',
	LOGGING_ROTATION_ENABLED: 'logging_rotation_enabled',
	LOGGING_ROTATION_COMPRESS: 'logging_rotation_compress',
	LOGGING_ROTATION_INTERVAL: 'logging_rotation_interval',
	LOGGING_ROTATION_MAXSIZE: 'logging_rotation_maxSize',
	LOGGING_ROTATION_PATH: 'logging_rotation_path',
	LOGGING_ROTATION_RETENTION: 'logging_rotation_retention',
	LOGGING_STDSTREAMS: 'logging_stdStreams',
	LOGGING_AUDITLOG: 'logging_auditLog',
	LOGGING_AUDITRETENTION: 'logging_auditRetention',
	LOGGING_AUDITAUTHEVENTS_LOGFAILED: 'logging_auditAuthEvents_logFailed',
	LOGGING_AUDITAUTHEVENTS_LOGSUCCESSFUL: 'logging_auditAuthEvents_logSuccessful',
	OPERATIONSAPI_NETWORK_CORS: 'operationsApi_network_cors',
	OPERATIONSAPI_NETWORK_CORSACCESSLIST: 'operationsApi_network_corsAccessList',
	OPERATIONSAPI_NETWORK_HEADERSTIMEOUT: 'operationsApi_network_headersTimeout',
	OPERATIONSAPI_NETWORK_HTTPS: 'operationsApi_network_https',
	OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT: 'operationsApi_network_keepAliveTimeout',
	OPERATIONSAPI_NETWORK_PORT: 'operationsApi_network_port',
	OPERATIONSAPI_NETWORK_DOMAINSOCKET: 'operationsApi_network_domainSocket',
	OPERATIONSAPI_NETWORK_SECUREPORT: 'operationsApi_network_securePort',
	OPERATIONSAPI_NETWORK_HTTP2: 'operationsApi_network_http2',
	OPERATIONSAPI_TLS: 'operationsApi_tls',
	OPERATIONSAPI_TLS_CERTIFICATE: 'operationsApi_tls_certificate',
	OPERATIONSAPI_TLS_PRIVATEKEY: 'operationsApi_tls_privateKey',
	OPERATIONSAPI_TLS_CERTIFICATEAUTHORITY: 'operationsApi_tls_certificateAuthority',
	OPERATIONSAPI_NETWORK_TIMEOUT: 'operationsApi_network_timeout',
	OPERATIONSAPI_SYSINFO_NETWORK: 'operationsApi_sysInfo_network',
	OPERATIONSAPI_SYSINFO_DISK: 'operationsApi_sysInfo_disk',
	REPLICATION: 'replication',
	REPLICATION_HOSTNAME: 'replication_hostname',
	REPLICATION_URL: 'replication_url',
	REPLICATION_PORT: 'replication_port',
	REPLICATION_SECUREPORT: 'replication_securePort',
	REPLICATION_ROUTES: 'replication_routes',
	REPLICATION_DATABASES: 'replication_databases',
	REPLICATION_ENABLEROOTCAS: 'replication_enableRootCAs',
	REPLICATION_SHARD: 'replication_shard',
	ROOTPATH: 'rootPath',
	SERIALIZATION_BIGINT: 'serialization_bigInt',
	STORAGE_WRITEASYNC: 'storage_writeAsync',
	STORAGE_OVERLAPPINGSYNC: 'storage_overlappingSync',
	STORAGE_CACHING: 'storage_caching',
	STORAGE_COMPRESSION: 'storage_compression',
	STORAGE_NOREADAHEAD: 'storage_noReadAhead',
	STORAGE_PREFETCHWRITES: 'storage_prefetchWrites',
	STORAGE_ENCRYPTION: 'storage_encryption',
	STORAGE_MAXTRANSACTIONQUEUETIME: 'storage_maxTransactionQueueTime',
	STORAGE_PATH: 'storage_path',
	STORAGE_BLOBPATHS: 'storage_blobPaths',
	STORAGE_AUDIT_PATH: 'storage_audit_path',
	STORAGE_MAXFREESPACETOLOAD: 'storage_maxFreeSpaceToLoad',
	STORAGE_MAXFREESPACETORETAIN: 'storage_maxFreeSpaceToRetain',
	STORAGE_PAGESIZE: 'storage_pageSize',
	STORAGE_COMPRESSION_DICTIONARY: 'storage_compression_dictionary',
	STORAGE_COMPRESSION_THRESHOLD: 'storage_compression_threshold',
	STORAGE_COMPACTONSTART: 'storage_compactOnStart',
	STORAGE_COMPACTONSTARTKEEPBACKUP: 'storage_compactOnStartKeepBackup',
	STORAGE_RECLAMATION_THRESHOLD: 'storage_reclamation_threshold',
	STORAGE_RECLAMATION_INTERVAL: 'storage_reclamation_interval',
	STORAGE_RECLAMATION_EVICTIONFACTOR: 'storage_reclamation_evictionFactor',
	DATABASES: 'databases',
	IGNORE_SCRIPTS: 'ignoreScripts',
	MQTT_NETWORK_PORT: 'mqtt_network_port',
	MQTT_WEBSOCKET: 'mqtt_webSocket',
	MQTT_NETWORK_SECUREPORT: 'mqtt_network_securePort',
	MQTT_NETWORK_MTLS: 'mqtt_network_mtls',
	MQTT_NETWORK_MTLS_REQUIRED: 'mqtt_network_mtls_required',
	MQTT_NETWORK_MTLS_CERTIFICATEAUTHORITY: 'mqtt_network_mtls_certificateAuthority',
	MQTT_NETWORK_MTLS_USER: 'mqtt_network_mtls_user',
	MQTT_REQUIREAUTHENTICATION: 'mqtt_requireAuthentication',
	COMPONENTSROOT: 'componentsRoot',
	TLS_CERTIFICATE: 'tls_certificate',
	TLS_PRIVATEKEY: 'tls_privateKey',
	TLS_CERTIFICATEAUTHORITY: 'tls_certificateAuthority',
	TLS_CIPHERS: 'tls_ciphers',
	TLS: 'tls',
	CLONED: 'cloned',
} as const;

/**
 * This constant maps user-provided configuration parameters (from CLI, environment variables, etc.) to the
 * case-sensitive configuration parameters. New parameters added to the CONFIG_PARAMS constant above are
 * dynamically included in this mapping via the subsequent for loop, eliminating the need for manual updates.
 * Additionally, this constant serves to map old configuration parameters to their updated counterparts.
 */
export const CONFIG_PARAM_MAP = {
	settings_path: BOOT_PROP_PARAMS.SETTINGS_PATH_KEY,
	hdb_root_key: CONFIG_PARAMS.ROOTPATH,
	hdb_root: CONFIG_PARAMS.ROOTPATH,
	rootpath: CONFIG_PARAMS.ROOTPATH,
	server_port_key: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT,
	server_port: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT,
	cert_key: CONFIG_PARAMS.TLS_CERTIFICATE,
	certificate: CONFIG_PARAMS.TLS_CERTIFICATE,
	private_key_key: CONFIG_PARAMS.TLS_PRIVATEKEY,
	private_key: CONFIG_PARAMS.TLS_PRIVATEKEY,
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
	clustering_node_name_key: CONFIG_PARAMS.CLUSTERING_NODENAME,
	node_name: CONFIG_PARAMS.CLUSTERING_NODENAME,
	clustering_enabled_key: CONFIG_PARAMS.CLUSTERING_ENABLED,
	clustering: CONFIG_PARAMS.CLUSTERING_ENABLED,
	max_http_threads: CONFIG_PARAMS.THREADS_COUNT,
	max_hdb_processes: CONFIG_PARAMS.THREADS_COUNT,
	server_timeout_key: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_TIMEOUT,
	server_timeout_ms: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_TIMEOUT,
	server_keep_alive_timeout_key: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT,
	server_keep_alive_timeout: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT,
	server_headers_timeout_key: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_HEADERSTIMEOUT,
	server_headers_timeout: CONFIG_PARAMS.OPERATIONSAPI_NETWORK_HEADERSTIMEOUT,
	disable_transaction_log_key: CONFIG_PARAMS.LOGGING_AUDITLOG,
	disable_transaction_log: CONFIG_PARAMS.LOGGING_AUDITLOG,
	operation_token_timeout_key: CONFIG_PARAMS.AUTHENTICATION_OPERATIONTOKENTIMEOUT,
	operation_token_timeout: CONFIG_PARAMS.AUTHENTICATION_OPERATIONTOKENTIMEOUT,
	refresh_token_timeout_key: CONFIG_PARAMS.AUTHENTICATION_REFRESHTOKENTIMEOUT,
	refresh_token_timeout: CONFIG_PARAMS.AUTHENTICATION_REFRESHTOKENTIMEOUT,
	custom_functions_port_key: CONFIG_PARAMS.HTTP_PORT,
	custom_functions_port: CONFIG_PARAMS.HTTP_PORT,
	custom_functions_directory_key: CONFIG_PARAMS.COMPONENTSROOT,
	custom_functions_directory: CONFIG_PARAMS.COMPONENTSROOT,
	max_custom_function_processes: CONFIG_PARAMS.THREADS_COUNT,
	logging_console: CONFIG_PARAMS.LOGGING_CONSOLE,
	log_to_file: CONFIG_PARAMS.LOGGING_FILE,
	log_to_stdstreams: CONFIG_PARAMS.LOGGING_STDSTREAMS,
	local_studio_on: CONFIG_PARAMS.LOCALSTUDIO_ENABLED,
	clustering_port: CONFIG_PARAMS.CLUSTERING_HUBSERVER_CLUSTER_NETWORK_PORT,
	clustering_user: CONFIG_PARAMS.CLUSTERING_USER,
	customfunctions_network_port: CONFIG_PARAMS.HTTP_PORT,
	customfunctions_tls_certificate: CONFIG_PARAMS.TLS_CERTIFICATE,
	customfunctions_network_cors: CONFIG_PARAMS.HTTP_CORS,
	customfunctions_network_corsaccesslist: CONFIG_PARAMS.HTTP_CORSACCESSLIST,
	customfunctions_network_headerstimeout: CONFIG_PARAMS.HTTP_HEADERSTIMEOUT,
	customfunctions_network_https: CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HTTPS,
	customfunctions_network_keepalivetimeout: CONFIG_PARAMS.HTTP_KEEPALIVETIMEOUT,
	customfunctions_tls_privatekey: CONFIG_PARAMS.TLS_PRIVATEKEY,
	customfunctions_tls_certificateauthority: CONFIG_PARAMS.TLS_CERTIFICATEAUTHORITY,
	customfunctions_network_timeout: CONFIG_PARAMS.HTTP_TIMEOUT,
	customfunctions_tls: CONFIG_PARAMS.TLS,
	http_threads: CONFIG_PARAMS.THREADS_COUNT,
	threads: CONFIG_PARAMS.THREADS_COUNT,
	threads_count: CONFIG_PARAMS.THREADS_COUNT,
	customfunctions_processes: CONFIG_PARAMS.THREADS_COUNT,
	customfunctions_root: CONFIG_PARAMS.COMPONENTSROOT,
	operationsapi_root: CONFIG_PARAMS.ROOTPATH,
}; // This object is dynamically populated below so don't mark as const until we can fix this up.

for (const key in CONFIG_PARAMS) {
	const name = CONFIG_PARAMS[key];
	CONFIG_PARAM_MAP[name.toLowerCase()] = name;
}

/** Database parameter config */
export const DATABASES_PARAM_CONFIG = {
	TABLES: 'tables',
	PATH: 'path',
	AUDIT_PATH: 'auditPath',
} as const;

/** Describes all available job types */
export const JOB_TYPE_ENUM = {
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
	restart_service: 'restart_service',
} as const;

/** Clustering Message types */
export const CLUSTER_MESSAGE_TYPE_ENUM = {
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
} as const;

/** Specifies values for licenses */
export const LICENSE_VALUES = {
	VERSION_DEFAULT: '2.2.0',
} as const;

/** The maximum ram allocation in MB per HDB child process */
export const RAM_ALLOCATION_ENUM = {
	DEVELOPMENT: 8192, //8GB
	DEFAULT: 512, //.5GB
} as const;

/** Common Node.js Error Codes */
export const NODE_ERROR_CODES = {
	ENOENT: 'ENOENT', // No such file or directory.
	EACCES: 'EACCES', // Permission denied.
	EEXIST: 'EEXIST', // File already exists.
	ERR_INVALID_ARG_TYPE: 'ERR_INVALID_ARG_TYPE',
} as const;

// TODO: Wherever this is used, replace this with a private property
/** Symbol for metadata */
export const METADATA_PROPERTY = Symbol('metadata');

/** Clustering flag */
export const CLUSTERING_FLAG = '__clustering__';

const CREATED_TIME = '__createdtime__';
const UPDATED_TIME = '__updatedtime__';

/** Timestamp keys */
export const TIME_STAMP_NAMES_ENUM = {
	CREATED_TIME,
	UPDATED_TIME,
} as const;

/** Timestamp values */
export const TIME_STAMP_NAMES = [CREATED_TIME, UPDATED_TIME] as const;

/**
 * This value is used to help evaluate whether or not a permissions translation error is related to old permissions values or if it could be another code-related bug/error.
 */
export const PERMS_UPDATE_RELEASE_TIMESTAMP = 1598486400000;

/** Search comparator value strings */
export const VALUE_SEARCH_COMPARATORS = {
	LESS: '<',
	LESS_OR_EQ: '<=',
	GREATER: '>',
	GREATER_OR_EQ: '>=',
	BETWEEN: '...',
} as const;

/** Inverted form of VALUE_SEARCH_COMPARATORS */
export const VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP = {
	'<': 'LESS',
	'<=': 'LESS_OR_EQ',
	'>': 'GREATER',
	'>=': 'GREATER_OR_EQ',
	'...': 'BETWEEN',
} as const;

/** Standard CRUD operation map */
export const PERMS_CRUD_ENUM = {
	READ: 'read',
	INSERT: 'insert',
	UPDATE: 'update',
	DELETE: 'delete',
} as const;

/** Search wildcards */
export const SEARCH_WILDCARDS = ['*', '%'] as const;

/** Function value used in data layer and SQL transactions */
export const FUNC_VAL = 'func_val';

/** Audit log search types for read operation */
export const READ_AUDIT_LOG_SEARCH_TYPES_ENUM = {
	HASH_VALUE: 'hash_value',
	TIMESTAMP: 'timestamp',
	USERNAME: 'username',
} as const;

/** JWT key and pass file names */
export const JWT_ENUM = {
	JWT_PRIVATE_KEY_NAME: '.jwtPrivate.key',
	JWT_PUBLIC_KEY_NAME: '.jwtPublic.key',
	JWT_PASSPHRASE_NAME: '.jwtPass',
} as const;

/** ITC Channel Event types */
export const ITC_EVENT_TYPES = {
	SHUTDOWN: 'shutdown',
	CHILD_STARTED: 'child_started',
	CHILD_STOPPED: 'child_stopped',
	SCHEMA: 'schema',
	USER: 'user',
	CLUSTER_STATUS_RESPONSE: 'cluster_status_response',
	CLUSTER_STATUS_REQUEST: 'cluster_status_request',
	METRICS: 'metrics',
	GET_METRICS: 'get_metrics',
	RESTART: 'restart',
	START_JOB: 'start_job',
	NATS_CONSUMER_UPDATE: 'nats_consumer_update',
	COMPONENT_STATUS_REQUEST: 'component_status_request',
	COMPONENT_STATUS_RESPONSE: 'component_status_response',
} as const;

/** Supported thread types */
export const THREAD_TYPES = {
	HTTP: 'http',
} as const;

/** A version string for pre 4.0.0 comparison */
export const PRE_4_0_0_VERSION = '3.x.x';

/** Authentication audit statusses */
export const AUTH_AUDIT_STATUS = {
	SUCCESS: 'success',
	FAILURE: 'failure',
} as const;

/** Authentication audit types */
export const AUTH_AUDIT_TYPES = {
	AUTHENTICATION: 'authentication',
	AUTHORIZATION: 'authorization',
} as const;
