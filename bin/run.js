'use strict';

const env = require('../utility/environment/environmentManager');
env.initSync();

const terms = require('../utility/hdbTerms');
const hdb_logger = require('../utility/logging/harper_logger');
const fs = require('fs-extra');
const path = require('path');
const check_jwt_tokens = require('../utility/install/checkJWTTokensExist');
const install = require('../utility/install/installer');
const chalk = require('chalk');
const pjson = require('../package.json');
const install_user_permission = require('../utility/install_user_permission');
const hdb_utils = require('../utility/common_utils');
const config_utils = require('../config/configUtils');
const assignCMDENVVariables = require('../utility/assignCmdEnvVariables');
const nats_config = require('../server/nats/utility/natsConfig');
const { promisify } = require('util');
const stop = require('./stop');
const upgrade = require('./upgrade');
const minimist = require('minimist');
const spawn = require('child_process').spawn;
const { PACKAGE_ROOT } = require('../utility/hdbTerms');
const { startHTTPThreads, startSocketServer, mostIdleRouting, remoteAffinityRouting } = require('../server/threads/socket-router');

const hdbInfoController = require('../data_layer/hdbInfoController');

const SYSTEM_SCHEMA = require('../json/systemSchema.json');
const schema_describe = require('../data_layer/schemaDescribe');
const lmdb_create_txn_environment = require('../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbCreateTransactionsAuditEnvironment');

let pm2_utils;

const CreateTableObject = require('../data_layer/CreateTableObject');
const hdb_terms = require('../utility/hdbTerms');

// These may change to match unix return codes (i.e. 0, 1)
const ENOENT_ERR_CODE = -2;

const UPGRADE_COMPLETE_MSG = 'Upgrade complete.  Starting HarperDB.';
const UPGRADE_ERR = 'Got an error while trying to upgrade your HarperDB instance.  Exiting HarperDB.';
const HDB_NOT_FOUND_MSG = 'HarperDB not found, starting install process.';
const INSTALL_ERR = 'There was an error during install, check install_log.log for more details.  Exiting.';
const HDB_STARTED = 'HarperDB successfully started.';

/**
 * Do the initial checks and potential upgrades/installation
 * @param called_by_install
 * @returns {Promise<void>}
 */
async function initialize(called_by_install = false, called_by_main = false) {
	// Check to see if HDB is installed, if it isn't we call install.
	console.log(chalk.magenta('Starting HarperDB...'));

	if ((await isHdbInstalled()) === false) {
		console.log(HDB_NOT_FOUND_MSG);
		try {
			await install();
		} catch (err) {
			console.error(INSTALL_ERR);
			hdb_logger.error(err);
			process.exit(1);
		}
	}

	// Set where the pm2.log file is created. This has to be done before pm2 is imported.
	process.env.PM2_LOG_FILE_PATH = path.join(env.getHdbBasePath(), 'log', 'pm2.log');

	// Requiring the pm2 mod will create the .pm2 dir. This code is here to allow install to set pm2 env vars before that is done.
	if (pm2_utils === undefined) pm2_utils = require('../utility/pm2/utilityFunctions');

	hdb_logger.createLogFile(terms.PROCESS_LOG_NAMES.CLI, terms.PROCESS_DESCRIPTORS.RUN);

	// The called by install check is here because if cmd/env args are passed to install (which calls run when done)
	// we do not need to update/backup the config file on run.
	if (!called_by_install) {
		// If run is called with cmd/env vars we create a backup of config and update config file.
		const parsed_args = assignCMDENVVariables(Object.keys(terms.CONFIG_PARAM_MAP), true);
		if (!hdb_utils.isEmpty(parsed_args) && !hdb_utils.isEmptyOrZeroLength(Object.keys(parsed_args))) {
			config_utils.updateConfigValue(undefined, undefined, parsed_args, true, true);
		}
	}

	// Check to see if an upgrade is needed based on existing hdb_info data.  If so, we need to force the user to upgrade
	// before the server can be started.
	let upgrade_vers;
	try {
		const update_obj = await hdbInfoController.getVersionUpdateInfo();
		if (update_obj !== undefined) {
			upgrade_vers = update_obj[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.UPGRADE_VERSION];
			await upgrade.upgrade(update_obj);
			console.log(UPGRADE_COMPLETE_MSG);
		}
	} catch (err) {
		if (upgrade_vers) {
			console.error(
				`Got an error while trying to upgrade your HarperDB instance to version ${upgrade_vers}.  Exiting HarperDB.`
			);
			hdb_logger.error(err);
		} else {
			console.error(UPGRADE_ERR);
			hdb_logger.error(err);
		}
		process.exit(1);
	}

	check_jwt_tokens();
	await checkAuditLogEnvironmentsExist();
	writeLicenseFromVars();

	// Check user has required permissions to start HDB.
	try {
		install_user_permission.checkPermission();
	} catch (err) {
		hdb_logger.error(err);
		console.error(err.message);
		process.exit(1);
	}

	const clustering_enabled = hdb_utils.autoCastBoolean(env.get(terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY));
	if (clustering_enabled) {
		await nats_config.generateNatsConfig(called_by_main);
	}

	await pm2_utils.configureLogRotate();
}
/**
 * Starts Harper DB threads
 * If the hdb_boot_props file is not found, it is assumed an install needs to be performed.
 * @param called_by_install - If run is called by install we want to ignore any
 * cmd/env args as they would have already been written to config on install.
 * @returns {Promise<void>}
 */
async function main(called_by_install = false) {
	try {
		const cmd_args = minimist(process.argv);
		if (cmd_args.ROOTPATH) {
			config_utils.updateConfigObject('settings_path', path.join(cmd_args.ROOTPATH, terms.HDB_CONFIG_FILE));
		}
		await initialize(called_by_install, true);
		const clustering_enabled = hdb_utils.autoCastBoolean(env.get(terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY));
		const is_scripted = process.env.IS_SCRIPTED_SERVICE && !cmd_args.service;
		const start_clustering = clustering_enabled && !is_scripted;
		const custom_func_enabled = hdb_utils.autoCastBoolean(
			env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY)
		);

		// Run can be called with a --service argument which allows designated services to be started.
		if (!hdb_utils.isEmpty(cmd_args.service)) {
			if (typeof cmd_args.service !== 'string') {
				const service_err_msg = `Run service argument expected a string but received: ${cmd_args.service}`;
				hdb_logger.error(service_err_msg);
				console.log(service_err_msg);
				process.exit(1);
			}

			const cmd_args_array = cmd_args.service.split(',');
			for (const args of cmd_args_array) {
				const service = args.toLowerCase();
				if (terms.PROCESS_DESCRIPTORS_VALIDATE[service] === undefined) {
					hdb_logger.error(`Run received unrecognized service command argument: ${service}`);
					continue;
				}

				// If custom functions not enabled in settings.js do not start.
				if (service === terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS.toLowerCase() && !custom_func_enabled) {
					hdb_logger.error(`${service} is not enabled in settings`);
					continue;
				}

				// If clustering not enabled in settings.js do not start.
				if (service.includes('clustering') && !clustering_enabled) {
					hdb_logger.error(`${service} is not enabled in settings`);
					continue;
				}

				if (service === 'clustering') {
					// Start all services that are required for clustering
					await pm2_utils.startClustering();
				} else {
					await pm2_utils.startService(terms.PROCESS_DESCRIPTORS_VALIDATE[service]);
				}

				const log_msg = `${terms.PROCESS_DESCRIPTORS_VALIDATE[service]} successfully started.`;
				hdb_logger.notify(log_msg);
				console.log(log_msg);
			}

		} else {
			startHTTPThreads(env.get(hdb_terms.CONFIG_PARAMS.HTTP_THREADS));
			const REMOTE_ADDRESS_AFFINITY = env.get(hdb_terms.CONFIG_PARAMS.HTTP_REMOTE_ADDRESS_AFFINITY);
			startSocketServer(terms.SERVICES.HDB_CORE,
				parseInt(env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT), 10),
				REMOTE_ADDRESS_AFFINITY ? remoteAffinityRouting : mostIdleRouting);
			if (custom_func_enabled) {
				startSocketServer(terms.SERVICES.CUSTOM_FUNCTIONS, parseInt(env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_PORT), 10));
			}
			if (start_clustering) await pm2_utils.startClustering();
		}
		if (!is_scripted) started();
	} catch (err) {
		console.error(err);
		hdb_logger.error(err);
		process.exit(1);
	}
}
function started() {
	// Console log Harper dog logo
	console.log(chalk.magenta('' + fs.readFileSync(path.join(PACKAGE_ROOT, 'utility/install/ascii_logo.txt'))));
	console.log(chalk.magenta(`|------------- HarperDB ${pjson.version} successfully started ------------|`));

	hdb_logger.notify(HDB_STARTED);
}
/**
 * Launches a separate process for HarperDB and then exits. This is an unusual practice and is anathema
 * to the way processes are typically handled, both in terminal and for services (systemd), but this functionality
 * is retained for legacy purposes.
 * @returns {Promise<void>} // ha ha, it doesn't!
 */
async function launch() {
	if (getRunInForeground()) {
		return main();
	}
	try {
		if (pm2_utils === undefined) pm2_utils = require('../utility/pm2/utilityFunctions');
		pm2_utils.enterScriptingMode();
		await initialize();
		const clustering_enabled = hdb_utils.autoCastBoolean(env.get(terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY));
		if (clustering_enabled) await pm2_utils.startClustering();
		await pm2_utils.startService(terms.PROCESS_DESCRIPTORS.HDB);
		started();
		process.exit(0);
	} catch (err) {
		console.error(err);
		hdb_logger.error(err);
		process.exit(1);
	}
}

/**
 * This function looks for HARPERDB_FINGERPRINT & HARPERDB_LICENSE in env / cmd.
 * If both are found the values will be written to the fingerprint / license files
 */
function writeLicenseFromVars() {
	const LICENSE_PATH = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.LICENSE_FILE_NAME);
	const LICENSE_FILE = path.join(LICENSE_PATH, terms.LICENSE_FILE_NAME);
	const FINGER_PRINT_FILE = path.join(LICENSE_PATH, terms.REG_KEY_FILE_NAME);

	try {
		const { HARPERDB_FINGERPRINT, HARPERDB_LICENSE } = assignCMDENVVariables([
			'HARPERDB_FINGERPRINT',
			'HARPERDB_LICENSE',
		]);
		if (hdb_utils.isEmpty(HARPERDB_FINGERPRINT) || hdb_utils.isEmpty(HARPERDB_LICENSE)) {
			return;
		}

		fs.mkdirpSync(LICENSE_PATH);
		fs.writeFileSync(FINGER_PRINT_FILE, HARPERDB_FINGERPRINT);
		fs.writeFileSync(LICENSE_FILE, HARPERDB_LICENSE);
	} catch (e) {
		const ERROR_MSG = `Failed to write license & fingerprint due to: ${e.message}`;
		console.error(ERROR_MSG);
		hdb_logger.error(ERROR_MSG);
	}
}

/**
 * iterates the system schema & all other schemas and makes sure there is a transaction audit environment for the schema.table
 * @returns {Promise<void>}
 */
async function checkAuditLogEnvironmentsExist() {
	if (env.getHdbBasePath() !== undefined) {
		hdb_logger.info('Checking Transaction Audit Environments exist');

		for (const table_name of Object.keys(SYSTEM_SCHEMA)) {
			await openCreateAuditEnvironment(terms.SYSTEM_SCHEMA_NAME, table_name);
		}

		let describe_results = await schema_describe.describeAll();

		for (const schema_name of Object.keys(describe_results)) {
			for (const table_name of Object.keys(describe_results[schema_name])) {
				await openCreateAuditEnvironment(schema_name, table_name);
			}
		}

		hdb_logger.info('Finished checking Transaction Audit Environments exist');
	}
}

/**
 * runs the create environment command for the specified schema.table
 * @param {string} schema
 * @param {string} table_name
 * @returns {Promise<void>}
 */
async function openCreateAuditEnvironment(schema, table_name) {
	try {
		let create_tbl_obj = new CreateTableObject(schema, table_name);
		await lmdb_create_txn_environment(create_tbl_obj);
	} catch (e) {
		let error_msg = `Unable to create the transaction audit environment for ${schema}.${table_name}, due to: ${e.message}`;
		console.error(error_msg);
		hdb_logger.error(error_msg);
	}
}

/**
 * If running in foreground and exit event occurs stop is called
 * @returns {Promise<void>}
 */
async function processExitHandler() {
	try {
		await stop.stop();
	} catch (err) {
		console.error(err);
	}
	process.exit(143);
}

module.exports = {
	launch,
	main,
};

/**
 *
 * @returns {Promise<boolean>}
 */
async function isHdbInstalled() {
	try {
		await fs.stat(hdb_utils.getPropsFilePath());
		await fs.stat(env.get(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
	} catch (err) {
		if (err.code === 'ENOENT') {
			// boot props not found, hdb not installed
			return false;
		}

		hdb_logger.error(`Error checking for HDB install - ${err}`);
		throw err;
	}

	return true;
}

function getRunInForeground() {
	return hdb_utils.autoCastBoolean(env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_FOREGROUND));
}
