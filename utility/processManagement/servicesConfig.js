'use strict';

const env = require('../environment/environmentManager.js');
const hdbTerms = require('../hdbTerms.ts');
const natsTerms = require('../../server/nats/utility/natsTerms.js');
const path = require('path');
const { PACKAGE_ROOT } = require('../../utility/packageUtils.js');
const envManager = require('../environment/environmentManager.js');
const hdbUtils = require('../common_utils.js');

const DISABLE_FILE_LOG = '/dev/null';
const LAUNCH_SCRIPTS_DIR = path.join(PACKAGE_ROOT, 'launchServiceScripts');
const SCRIPTS_DIR = path.join(PACKAGE_ROOT, 'utility/scripts');
const RESTART_SCRIPT = path.join(SCRIPTS_DIR, hdbTerms.HDB_RESTART_SCRIPT);
const NATS_SERVER_BINARY_PATH = path.resolve(
	PACKAGE_ROOT,
	'dependencies',
	`${process.platform}-${process.arch}`,
	natsTerms.NATS_BINARY_NAME
);

function generateMainServerConfig() {
	const envVars = { [hdbTerms.PROCESS_NAME_ENV_PROP]: hdbTerms.PROCESS_DESCRIPTORS.HDB, IS_SCRIPTED_SERVICE: true };
	if (hdbUtils.noBootFile()) envVars[hdbTerms.CONFIG_PARAMS.ROOTPATH.toUpperCase()] = hdbUtils.getEnvCliRootPath();

	// We are using launch scripts here because something was happening with the build where stdout/err was
	// losing reference to the pm2 process and not being logged. It seems to only happen with clustered processes.
	return {
		name: hdbTerms.PROCESS_DESCRIPTORS.HDB,
		script: hdbTerms.LAUNCH_SERVICE_SCRIPTS.MAIN,
		exec_mode: 'fork',
		env: envVars,
		cwd: PACKAGE_ROOT,
	};
}

const ELIDED_HUB_PORT = 9930;
function generateNatsHubServerConfig() {
	env.initSync(true);
	const hdbRoot = env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH);
	const hubConfigPath = path.join(hdbRoot, 'clustering', natsTerms.NATS_CONFIG_FILES.HUB_SERVER);
	const hubLogs = path.join(env.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY), hdbTerms.LOG_NAMES.HDB);
	const hubPort = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT);
	const natsLoggingFlag =
		natsTerms.LOG_LEVEL_FLAGS[env.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LOGLEVEL)] ?? undefined;
	const hsConfig = {
		name: hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_HUB + (hubPort !== ELIDED_HUB_PORT ? '-' + hubPort : ''),
		script: NATS_SERVER_BINARY_PATH,
		args: natsLoggingFlag ? `${natsLoggingFlag} -c ${hubConfigPath}` : `-c ${hubConfigPath}`,
		exec_mode: 'fork',
		env: { [hdbTerms.PROCESS_NAME_ENV_PROP]: hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_HUB },
		merge_logs: true,
		out_file: hubLogs,
		error_file: hubLogs,
		instances: 1,
	};

	if (!env.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_TO_FILE)) {
		hsConfig.out_file = DISABLE_FILE_LOG;
		hsConfig.error_file = DISABLE_FILE_LOG;
	}

	return hsConfig;
}

const ELIDED_LEAF_PORT = 9940;
function generateNatsLeafServerConfig() {
	env.initSync(true);
	const hdbRoot = env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH);
	const leafConfigPath = path.join(hdbRoot, 'clustering', natsTerms.NATS_CONFIG_FILES.LEAF_SERVER);
	const leafLogs = path.join(env.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY), hdbTerms.LOG_NAMES.HDB);
	const leafPort = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT);
	const natsLoggingFlag =
		natsTerms.LOG_LEVEL_FLAGS[env.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LOGLEVEL)] ?? undefined;
	const lsConfig = {
		// we assign a unique name per port if it is not the default, so we can run multiple NATS instances for
		// multiple HDB instances
		name: hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF + (leafPort !== ELIDED_LEAF_PORT ? '-' + leafPort : ''),
		script: NATS_SERVER_BINARY_PATH,
		args: natsLoggingFlag ? `${natsLoggingFlag} -c ${leafConfigPath}` : `-c ${leafConfigPath}`,
		exec_mode: 'fork',
		env: { [hdbTerms.PROCESS_NAME_ENV_PROP]: hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF },
		merge_logs: true,
		out_file: leafLogs,
		error_file: leafLogs,
		instances: 1,
	};

	if (!env.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_TO_FILE)) {
		lsConfig.out_file = DISABLE_FILE_LOG;
		lsConfig.error_file = DISABLE_FILE_LOG;
	}

	return lsConfig;
}

/**
 * Generates the config used to launch a process that will upgrade pre 4.0.0 instances clustering node connections
 * @returns {{cwd: string, merge_logs: boolean, out_file: string, instances: number, name: string, env: {}, error_file: string, script: string, exec_mode: string}}
 */
function generateClusteringUpgradeV4ServiceConfig() {
	env.initSync();
	const clusteringUpgradeLogs = path.join(env.get(hdbTerms.CONFIG_PARAMS.LOGGING_ROOT), hdbTerms.LOG_NAMES.HDB);
	const clusteringUpgradeConfig = {
		name: hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_UPGRADE_4_0_0,
		script: hdbTerms.LAUNCH_SERVICE_SCRIPTS.NODES_UPGRADE_4_0_0,
		exec_mode: 'fork',
		env: { [hdbTerms.PROCESS_NAME_ENV_PROP]: hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_UPGRADE_4_0_0 },
		merge_logs: true,
		out_file: clusteringUpgradeLogs,
		error_file: clusteringUpgradeLogs,
		instances: 1,
		cwd: LAUNCH_SCRIPTS_DIR,
		autorestart: false,
	};

	if (!env.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_TO_FILE)) {
		clusteringUpgradeConfig.out_file = DISABLE_FILE_LOG;
		clusteringUpgradeConfig.error_file = DISABLE_FILE_LOG;
	}

	return clusteringUpgradeConfig;
}

function generateRestart() {
	const envVars = { [hdbTerms.PROCESS_NAME_ENV_PROP]: hdbTerms.PROCESS_DESCRIPTORS.RESTART_HDB };
	if (hdbUtils.noBootFile()) envVars[hdbTerms.CONFIG_PARAMS.ROOTPATH.toUpperCase()] = hdbUtils.getEnvCliRootPath();
	const restartConfig = {
		name: hdbTerms.PROCESS_DESCRIPTORS.RESTART_HDB,
		exec_mode: 'fork',
		env: envVars,
		instances: 1,
		autorestart: false,
		cwd: SCRIPTS_DIR,
	};

	return {
		...restartConfig,
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
