'use strict';

const hdbTerms = require('../hdbTerms.ts');
const path = require('path');
const { PACKAGE_ROOT } = require('../../utility/packageUtils.js');
const hdbUtils = require('../common_utils.js');
const SCRIPTS_DIR = path.join(PACKAGE_ROOT, 'utility/scripts');
const RESTART_SCRIPT = path.join(SCRIPTS_DIR, hdbTerms.HDB_RESTART_SCRIPT);

function generateMainServerConfig() {
	const envVars = {
		[hdbTerms.PROCESS_NAME_ENV_PROP]: hdbTerms.PROCESS_DESCRIPTORS.HDB,
		IS_SCRIPTED_SERVICE: true,
		...process.env,
	};
	if (hdbUtils.noBootFile()) envVars[hdbTerms.CONFIG_PARAMS.ROOTPATH.toUpperCase()] = hdbUtils.getEnvCliRootPath();

	return {
		name: hdbTerms.PROCESS_DESCRIPTORS.HDB,
		script: hdbTerms.LAUNCH_SERVICE_SCRIPTS.MAIN,
		exec_mode: 'fork',
		env: envVars,
		execArgv: process.execArgv,
		cwd: PACKAGE_ROOT,
	};
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
};
