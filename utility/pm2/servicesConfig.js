'use strict';

const env = require('../environment/environmentManager');
env.initSync();
const hdb_license = require('../../utility/registration/hdb_license');
const hdb_terms = require('../hdbTerms');
const path = require('path');

const DEFAULT_OUT_FILE = '/dev/null';
const DEFAULT_ERROR_FILE = '/dev/null';
const BYTENODE_MOD_CLI = path.resolve(__dirname, '../../node_modules/bytenode/cli.js');
const LAUNCH_SCRIPTS_DIR = path.resolve(__dirname, '../../launchServiceScripts');
const SCRIPTS_DIR = path.resolve(__dirname, '../scripts');
const RESTART_SCRIPT = path.join(SCRIPTS_DIR, hdb_terms.HDB_RESTART_SCRIPT);

function generateIPCServerConfig() {
	const ipc_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.IPC,
		exec_mode: 'fork',
		out_file: DEFAULT_OUT_FILE,
		error_file: DEFAULT_ERROR_FILE,
		instances: 1,
		cwd: hdb_terms.SERVICE_SERVERS_CWD.IPC,
	};

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

function generateClusteringConnectorConfig() {
	const cc_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_CONNECTOR,
		exec_mode: 'fork',
		out_file: DEFAULT_OUT_FILE,
		error_file: DEFAULT_ERROR_FILE,
		instances: 1,
		cwd: hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING,
	};

	if (process.env.HDB_COMPILED === 'true') {
		return {
			...cc_config,
			script: BYTENODE_MOD_CLI,
			args: hdb_terms.SERVICE_SERVERS.CLUSTERING_CONNECTOR,
		};
	}

	return {
		...cc_config,
		script: hdb_terms.SERVICE_SERVERS.CLUSTERING_CONNECTOR,
	};
}

function generateClusteringServerConfig() {
	const cluster_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING,
		exec_mode: 'fork',
		out_file: DEFAULT_OUT_FILE,
		error_file: DEFAULT_ERROR_FILE,
		instances: 1,
		cwd: hdb_terms.SERVICE_SERVERS_CWD.CLUSTERING,
	};

	if (process.env.HDB_COMPILED === 'true') {
		return {
			...cluster_config,
			script: BYTENODE_MOD_CLI,
			args: hdb_terms.SERVICE_SERVERS.CLUSTERING,
		};
	}

	return {
		...cluster_config,
		script: hdb_terms.SERVICE_SERVERS.CLUSTERING,
	};
}

function generateHDBServerConfig() {
	env.initSync();
	const license = hdb_license.licenseSearch();
	const mem_value = license.ram_allocation
		? hdb_terms.MEM_SETTING_KEY + license.ram_allocation
		: hdb_terms.MEM_SETTING_KEY + hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT;

	// We are using launch scripts here because something was happening with the build where stdout/err was
	// losing reference to the pm2 process and not being logged. It seems to only happen with clustered processes.
	return {
		name: hdb_terms.PROCESS_DESCRIPTORS.HDB,
		script: hdb_terms.LAUNCH_SERVICE_SCRIPTS.HDB,
		exec_mode: 'cluster',
		out_file: DEFAULT_OUT_FILE,
		error_file: DEFAULT_ERROR_FILE,
		instances: env.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES),
		node_args: mem_value,
		cwd: LAUNCH_SCRIPTS_DIR,
	};
}

function generateCFServerConfig() {
	env.initSync();
	const license = hdb_license.licenseSearch();
	const mem_value = license.ram_allocation
		? hdb_terms.MEM_SETTING_KEY + license.ram_allocation
		: hdb_terms.MEM_SETTING_KEY + hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT;

	// We are using launch scripts here because something was happening with the build where stdout/err was
	// losing reference to the pm2 process and not being logged. It seems to only happen with clustered processes.
	return {
		name: hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS,
		script: hdb_terms.LAUNCH_SERVICE_SCRIPTS.CUSTOM_FUNCTIONS,
		exec_mode: 'cluster',
		out_file: DEFAULT_OUT_FILE,
		error_file: DEFAULT_ERROR_FILE,
		instances: env.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_CUSTOM_FUNCTION_PROCESSES),
		node_args: mem_value,
		cwd: LAUNCH_SCRIPTS_DIR,
	};
}

function generateRestart() {
	const restart_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.RESTART_HDB,
		exec_mode: 'fork',
		out_file: DEFAULT_OUT_FILE,
		error_file: DEFAULT_ERROR_FILE,
		instances: 1,
		autorestart: false,
		cwd: SCRIPTS_DIR,
	};

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
		apps: [
			generateIPCServerConfig(),
			generateHDBServerConfig(),
			generateClusteringServerConfig(),
			generateClusteringConnectorConfig(),
			generateCFServerConfig(),
		],
	};
}

module.exports = {
	generateAllServiceConfigs,
	generateIPCServerConfig,
	generateClusteringServerConfig,
	generateHDBServerConfig,
	generateCFServerConfig,
	generateClusteringConnectorConfig,
	generateRestart,
};
