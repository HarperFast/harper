'use strict';

const env = require('../environment/environmentManager');

const hdb_license = require('../../utility/registration/hdb_license');
const hdb_terms = require('../hdbTerms');
const nats_terms = require('../../server/nats/utility/natsTerms');
const path = require('path');

const DISABLE_FILE_LOG = '/dev/null';
const BYTENODE_MOD_CLI = path.resolve(__dirname, '../../node_modules/bytenode/lib/cli.js');
const LAUNCH_SCRIPTS_DIR = path.resolve(__dirname, '../../launchServiceScripts');
const SCRIPTS_DIR = path.resolve(__dirname, '../scripts');
const RESTART_SCRIPT = path.join(SCRIPTS_DIR, hdb_terms.HDB_RESTART_SCRIPT);
const NATS_SERVER_BINARY_PATH = path.resolve(__dirname, '../../dependencies', nats_terms.NATS_SERVER_NAME);
let log_to_file = undefined;
let log_path = undefined;

function initLogConfig() {
	if (log_to_file === undefined || log_path === undefined) {
		env.initSync();
		log_to_file = env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_TO_FILE);
		log_path = env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);
	}
}

function generateIPCServerConfig() {
	initLogConfig();

	const ipc_log = path.join(log_path, hdb_terms.PROCESS_LOG_NAMES.IPC);
	const ipc_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.IPC,
		exec_mode: 'fork',
		env: { [hdb_terms.PROCESS_NAME_ENV_PROP]: hdb_terms.PROCESS_DESCRIPTORS.IPC },
		merge_logs: true,
		out_file: ipc_log,
		error_file: ipc_log,
		instances: 1,
		cwd: hdb_terms.SERVICE_SERVERS_CWD.IPC,
	};

	if (!log_to_file) {
		ipc_config.out_file = DISABLE_FILE_LOG;
		ipc_config.error_file = DISABLE_FILE_LOG;
	}

	if (process.env.HDB_COMPILED === 'true') {
		return {
			...ipc_config,
			script: BYTENODE_MOD_CLI,
			args: hdb_terms.SERVICE_SERVERS.IPC,
		};
	}

	return {
		...ipc_config,
		script: hdb_terms.SERVICE_SERVERS.IPC,
	};
}

function generateHDBServerConfig() {
	initLogConfig();
	env.initSync();
	log_to_file = env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_TO_FILE);
	log_path = env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);

	const hdb_log = path.join(log_path, hdb_terms.PROCESS_LOG_NAMES.HDB);
	const license = hdb_license.licenseSearch();
	const mem_value = license.ram_allocation
		? hdb_terms.MEM_SETTING_KEY + license.ram_allocation
		: hdb_terms.MEM_SETTING_KEY + hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT;

	// We are using launch scripts here because something was happening with the build where stdout/err was
	// losing reference to the pm2 process and not being logged. It seems to only happen with clustered processes.
	const hdb_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.HDB,
		script: hdb_terms.LAUNCH_SERVICE_SCRIPTS.HDB,
		exec_mode: 'cluster',
		env: { [hdb_terms.PROCESS_NAME_ENV_PROP]: hdb_terms.PROCESS_DESCRIPTORS.HDB },
		merge_logs: true,
		out_file: hdb_log,
		error_file: hdb_log,
		instances: env.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES),
		node_args: mem_value,
		cwd: LAUNCH_SCRIPTS_DIR,
	};

	if (!log_to_file) {
		hdb_config.out_file = DISABLE_FILE_LOG;
		hdb_config.error_file = DISABLE_FILE_LOG;
	}

	return hdb_config;
}

function generateCFServerConfig() {
	initLogConfig();
	env.initSync();
	log_to_file = env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_TO_FILE);
	log_path = env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);

	const cf_logs = path.join(log_path, hdb_terms.PROCESS_LOG_NAMES.CUSTOM_FUNCTIONS);
	const license = hdb_license.licenseSearch();
	const mem_value = license.ram_allocation
		? hdb_terms.MEM_SETTING_KEY + license.ram_allocation
		: hdb_terms.MEM_SETTING_KEY + hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT;

	// We are using launch scripts here because something was happening with the build where stdout/err was
	// losing reference to the pm2 process and not being logged. It seems to only happen with clustered processes.
	const cf_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS,
		script: hdb_terms.LAUNCH_SERVICE_SCRIPTS.CUSTOM_FUNCTIONS,
		exec_mode: 'cluster',
		env: { [hdb_terms.PROCESS_NAME_ENV_PROP]: hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS },
		merge_logs: true,
		out_file: cf_logs,
		error_file: cf_logs,
		instances: env.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_CUSTOM_FUNCTION_PROCESSES),
		node_args: mem_value,
		cwd: LAUNCH_SCRIPTS_DIR,
	};

	if (!log_to_file) {
		cf_config.out_file = DISABLE_FILE_LOG;
		cf_config.error_file = DISABLE_FILE_LOG;
	}

	return cf_config;
}

function generateNatsHubServerConfig() {
	initLogConfig();
	env.initSync();
	log_to_file = env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_TO_FILE);
	log_path = env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);
	const hdb_root = env.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_ROOT);
	const hub_config_path = path.join(hdb_root, 'clustering', nats_terms.NATS_CONFIG_FILES.HUB_SERVER);
	const hub_logs = path.join(log_path, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_HUB);
	const hs_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB,
		script: `${NATS_SERVER_BINARY_PATH} -c ${hub_config_path}`,
		exec_mode: 'fork',
		env: { [hdb_terms.PROCESS_NAME_ENV_PROP]: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB },
		merge_logs: true,
		out_file: hub_logs,
		error_file: hub_logs,
		instances: 1,
		cwd: hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING_HUB,
	};

	if (!log_to_file) {
		hs_config.out_file = DISABLE_FILE_LOG;
		hs_config.error_file = DISABLE_FILE_LOG;
	}

	return hs_config;
}

function generateNatsLeafServerConfig() {
	initLogConfig();
	env.initSync();
	log_to_file = env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_TO_FILE);
	log_path = env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY);
	const hdb_root = env.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_ROOT);
	const leaf_config_path = path.join(hdb_root, 'clustering', nats_terms.NATS_CONFIG_FILES.LEAF_SERVER);
	const leaf_logs = path.join(log_path, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_LEAF);
	const ls_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF,
		script: `${NATS_SERVER_BINARY_PATH} -c ${leaf_config_path}`,
		exec_mode: 'fork',
		env: { [hdb_terms.PROCESS_NAME_ENV_PROP]: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF },
		merge_logs: true,
		out_file: leaf_logs,
		error_file: leaf_logs,
		instances: 1,
		cwd: hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING_LEAF,
	};

	if (!log_to_file) {
		ls_config.out_file = DISABLE_FILE_LOG;
		ls_config.error_file = DISABLE_FILE_LOG;
	}

	return ls_config;
}

function generateNatsIngestServiceConfig() {
	initLogConfig();
	env.initSync();
	const ingest_service_logs = path.join(log_path, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_INGEST_SERVICE);
	const ingest_ser_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_INGEST_SERVICE,
		script: hdb_terms.LAUNCH_SERVICE_SCRIPTS.NATS_INGEST_SERVICE,
		exec_mode: 'cluster',
		env: { [hdb_terms.PROCESS_NAME_ENV_PROP]: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_INGEST_SERVICE },
		merge_logs: true,
		out_file: ingest_service_logs,
		error_file: ingest_service_logs,
		instances: env.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_INGEST_SERVICE_PROCESSES),
		cwd: LAUNCH_SCRIPTS_DIR,
	};

	if (!log_to_file) {
		ingest_ser_config.out_file = DISABLE_FILE_LOG;
		ingest_ser_config.error_file = DISABLE_FILE_LOG;
	}

	return ingest_ser_config;
}

function generateNatsReplyServiceConfig() {
	initLogConfig();
	env.initSync();
	const reply_service_logs = path.join(log_path, hdb_terms.PROCESS_LOG_NAMES.CLUSTERING_REPLY_SERVICE);
	const reply_ser_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_REPLY_SERVICE,
		script: hdb_terms.LAUNCH_SERVICE_SCRIPTS.NATS_REPLY_SERVICE,
		exec_mode: 'cluster',
		env: { [hdb_terms.PROCESS_NAME_ENV_PROP]: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_REPLY_SERVICE },
		merge_logs: true,
		out_file: reply_service_logs,
		error_file: reply_service_logs,
		instances: env.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_REPLY_SERVICE_PROCESSES),
		cwd: LAUNCH_SCRIPTS_DIR,
	};

	if (!log_to_file) {
		reply_ser_config.out_file = DISABLE_FILE_LOG;
		reply_ser_config.error_file = DISABLE_FILE_LOG;
	}

	return reply_ser_config;
}

function generateRestart() {
	initLogConfig();

	const restart_log = path.join(log_path, hdb_terms.PROCESS_LOG_NAMES.PM2);
	const restart_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.RESTART_HDB,
		exec_mode: 'fork',
		env: { [hdb_terms.PROCESS_NAME_ENV_PROP]: hdb_terms.PROCESS_DESCRIPTORS.RESTART_HDB },
		merge_logs: true,
		out_file: restart_log,
		error_file: restart_log,
		instances: 1,
		autorestart: false,
		cwd: SCRIPTS_DIR,
	};

	if (!log_to_file) {
		restart_config.out_file = DISABLE_FILE_LOG;
		restart_config.error_file = DISABLE_FILE_LOG;
	}

	if (process.env.HDB_COMPILED === 'true') {
		return {
			...restart_config,
			script: BYTENODE_MOD_CLI,
			args: RESTART_SCRIPT,
		};
	}

	return {
		...restart_config,
		script: RESTART_SCRIPT,
	};
}

function generateAllServiceConfigs() {
	return {
		apps: [generateIPCServerConfig(), generateHDBServerConfig(), generateCFServerConfig()],
	};
}

module.exports = {
	generateAllServiceConfigs,
	generateIPCServerConfig,
	generateHDBServerConfig,
	generateCFServerConfig,
	generateRestart,
	generateNatsHubServerConfig,
	generateNatsLeafServerConfig,
	generateNatsIngestServiceConfig,
	generateNatsReplyServiceConfig,
};
