'use strict';

const env = require('../environment/environmentManager');
const hdb_license = require('../../utility/registration/hdb_license');
const hdb_terms = require('../hdbTerms');
const nats_terms = require('../../server/nats/utility/natsTerms');
const path = require('path');
const { PACKAGE_ROOT } = require('../../utility/packageUtils');
const env_manager = require('../environment/environmentManager');
const hdb_utils = require('../common_utils');

const DISABLE_FILE_LOG = '/dev/null';
const LAUNCH_SCRIPTS_DIR = path.join(PACKAGE_ROOT, 'launchServiceScripts');
const SCRIPTS_DIR = path.join(PACKAGE_ROOT, 'utility/scripts');
const RESTART_SCRIPT = path.join(SCRIPTS_DIR, hdb_terms.HDB_RESTART_SCRIPT);
const NATS_SERVER_BINARY_PATH = path.resolve(
	PACKAGE_ROOT,
	'dependencies',
	`${process.platform}-${process.arch}`,
	nats_terms.NATS_BINARY_NAME
);

function generateMainServerConfig() {
	const license = hdb_license.licenseSearch();
	const max_memory = license.ram_allocation || hdb_terms.RAM_ALLOCATION_ENUM.DEFAULT;
	const mem_value = hdb_terms.MEM_SETTING_KEY + max_memory;
	const env_vars = { [hdb_terms.PROCESS_NAME_ENV_PROP]: hdb_terms.PROCESS_DESCRIPTORS.HDB, IS_SCRIPTED_SERVICE: true };
	if (hdb_utils.noBootFile()) env_vars[hdb_terms.CONFIG_PARAMS.ROOTPATH.toUpperCase()] = hdb_utils.getEnvCliRootPath();

	// We are using launch scripts here because something was happening with the build where stdout/err was
	// losing reference to the pm2 process and not being logged. It seems to only happen with clustered processes.
	return {
		name: hdb_terms.PROCESS_DESCRIPTORS.HDB,
		script: hdb_terms.LAUNCH_SERVICE_SCRIPTS.MAIN,
		exec_mode: 'fork',
		env: env_vars,
		node_args: mem_value,
		cwd: PACKAGE_ROOT,
	};
}

const ELIDED_HUB_PORT = 9930;
function generateNatsHubServerConfig() {
	env.initSync(true);
	const hdb_root = env.get(hdb_terms.CONFIG_PARAMS.ROOTPATH);
	const hub_config_path = path.join(hdb_root, 'clustering', nats_terms.NATS_CONFIG_FILES.HUB_SERVER);
	const hub_logs = path.join(env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY), hdb_terms.LOG_NAMES.HDB);
	const hub_port = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT);
	const nats_logging_flag =
		nats_terms.LOG_LEVEL_FLAGS[env.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LOGLEVEL)] ?? undefined;
	const hs_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB + (hub_port !== ELIDED_HUB_PORT ? '-' + hub_port : ''),
		script: NATS_SERVER_BINARY_PATH,
		args: nats_logging_flag ? `${nats_logging_flag} -c ${hub_config_path}` : `-c ${hub_config_path}`,
		exec_mode: 'fork',
		env: { [hdb_terms.PROCESS_NAME_ENV_PROP]: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB },
		merge_logs: true,
		out_file: hub_logs,
		error_file: hub_logs,
		instances: 1,
	};

	if (!env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_TO_FILE)) {
		hs_config.out_file = DISABLE_FILE_LOG;
		hs_config.error_file = DISABLE_FILE_LOG;
	}

	return hs_config;
}

const ELIDED_LEAF_PORT = 9940;
function generateNatsLeafServerConfig() {
	env.initSync(true);
	const hdb_root = env.get(hdb_terms.CONFIG_PARAMS.ROOTPATH);
	const leaf_config_path = path.join(hdb_root, 'clustering', nats_terms.NATS_CONFIG_FILES.LEAF_SERVER);
	const leaf_logs = path.join(env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY), hdb_terms.LOG_NAMES.HDB);
	const leaf_port = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT);
	const nats_logging_flag =
		nats_terms.LOG_LEVEL_FLAGS[env.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LOGLEVEL)] ?? undefined;
	const ls_config = {
		// we assign a unique name per port if it is not the default, so we can run multiple NATS instances for
		// multiple HDB instances
		name: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF + (leaf_port !== ELIDED_LEAF_PORT ? '-' + leaf_port : ''),
		script: NATS_SERVER_BINARY_PATH,
		args: nats_logging_flag ? `${nats_logging_flag} -c ${leaf_config_path}` : `-c ${leaf_config_path}`,
		exec_mode: 'fork',
		env: { [hdb_terms.PROCESS_NAME_ENV_PROP]: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF },
		merge_logs: true,
		out_file: leaf_logs,
		error_file: leaf_logs,
		instances: 1,
	};

	if (!env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_TO_FILE)) {
		ls_config.out_file = DISABLE_FILE_LOG;
		ls_config.error_file = DISABLE_FILE_LOG;
	}

	return ls_config;
}

/**
 * Generates the config used to launch a process that will upgrade pre 4.0.0 instances clustering node connections
 * @returns {{cwd: string, merge_logs: boolean, out_file: string, instances: number, name: string, env: {}, error_file: string, script: string, exec_mode: string}}
 */
function generateClusteringUpgradeV4ServiceConfig() {
	env.initSync();
	const clustering_upgrade_logs = path.join(env.get(hdb_terms.CONFIG_PARAMS.LOGGING_ROOT), hdb_terms.LOG_NAMES.HDB);
	const clustering_upgrade_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_UPGRADE_4_0_0,
		script: hdb_terms.LAUNCH_SERVICE_SCRIPTS.NODES_UPGRADE_4_0_0,
		exec_mode: 'fork',
		env: { [hdb_terms.PROCESS_NAME_ENV_PROP]: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_UPGRADE_4_0_0 },
		merge_logs: true,
		out_file: clustering_upgrade_logs,
		error_file: clustering_upgrade_logs,
		instances: 1,
		cwd: LAUNCH_SCRIPTS_DIR,
		autorestart: false,
	};

	if (!env.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_TO_FILE)) {
		clustering_upgrade_config.out_file = DISABLE_FILE_LOG;
		clustering_upgrade_config.error_file = DISABLE_FILE_LOG;
	}

	return clustering_upgrade_config;
}

function generateRestart() {
	const env_vars = { [hdb_terms.PROCESS_NAME_ENV_PROP]: hdb_terms.PROCESS_DESCRIPTORS.RESTART_HDB };
	if (hdb_utils.noBootFile()) env_vars[hdb_terms.CONFIG_PARAMS.ROOTPATH.toUpperCase()] = hdb_utils.getEnvCliRootPath();
	const restart_config = {
		name: hdb_terms.PROCESS_DESCRIPTORS.RESTART_HDB,
		exec_mode: 'fork',
		env: env_vars,
		instances: 1,
		autorestart: false,
		cwd: SCRIPTS_DIR,
	};

	return {
		...restart_config,
		script: RESTART_SCRIPT,
	};
}

function generateAllServiceConfigs() {
	return {
		apps: [generateMainServerConfig()],
	};
}

module.exports = {
	generateAllServiceConfigs,
	generateMainServerConfig,
	generateRestart,
	generateNatsHubServerConfig,
	generateNatsLeafServerConfig,
	generateClusteringUpgradeV4ServiceConfig,
};
