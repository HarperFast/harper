'use strict';

const env = require('../utility/environment/environmentManager');
env.initSync();

const fs = require('fs-extra');
const path = require('path');
const check_jwt_tokens = require('../utility/install/checkJWTTokensExist');
const install = require('../utility/install/installer');
const colors = require('colors/safe');
const hdb_logger = require('../utility/logging/harper_logger');
const pjson = require(`${__dirname}/../package.json`);
const terms = require('../utility/hdbTerms');
const install_user_permission = require('../utility/install_user_permission');
const hdb_utils = require('../utility/common_utils');
const pm2_utils = require('../utility/pm2/utilityFunctions');
const config_utils = require('../config/configUtils');
const { promisify } = require('util');
const stop = require('./stop');
const upgrade = require('./upgrade');
const minimist = require('minimist');
const spawn = require('child_process').spawn;

const hdbInfoController = require('../data_layer/hdbInfoController');

const SYSTEM_SCHEMA = require('../json/systemSchema.json');
const schema_describe = require('../data_layer/schemaDescribe');
const lmdb_create_txn_environment = require('../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbCreateTransactionsEnvironment');
const bin_utility = require('./utility');

const CreateTableObject = require('../data_layer/CreateTableObject');

// These may change to match unix return codes (i.e. 0, 1)
const ENOENT_ERR_CODE = -2;

const UPGRADE_COMPLETE_MSG = 'Upgrade complete.  Starting HarperDB.';
const UPGRADE_ERR = 'Got an error while trying to upgrade your HarperDB instance.  Exiting HarperDB.';
const HDB_NOT_FOUND_MSG = 'HarperDB not found, starting install process.';
const INSTALL_ERR = 'There was an error during install, check install_log.log for more details.  Exiting.';
const HDB_STARTED = 'HarperDB successfully started.';

// promisified functions
const p_install_install = promisify(install.install);

/**
 * Starts Harper DB.
 * If the hdb_boot_props file is not found, it is assumed an install needs to be performed.
 * @param called_by_install - If run is called by install we want to ignore any
 * cmd/env args as they would have already been written to config on install.
 * @returns {Promise<void>}
 */
async function run(called_by_install = false) {
	// Check to see if HDB is installed, if it isn't we call install.
	try {
		console.log(colors.magenta('Starting HarperDB...'));

		if ((await isHdbInstalled()) === false) {
			console.log(HDB_NOT_FOUND_MSG);
			try {
				await p_install_install();
			} catch (err) {
				console.error(INSTALL_ERR);
				hdb_logger.error(err, true);
				process.exit(1);
			}
		}

		// The called by install check is here because if cmd/env args are passed to install (which calls run when done)
		// we do not need to update/backup the config file on run.
		if (!called_by_install) {
			// If run is called with cmd/env vars we create a backup of config and update config file.
			const parsed_args = hdb_utils.assignCMDENVVariables(Object.keys(terms.CONFIG_PARAM_MAP), true);
			if (!hdb_utils.isEmpty(parsed_args) && !hdb_utils.isEmptyOrZeroLength(Object.keys(parsed_args))) {
				config_utils.updateConfigValue(undefined, undefined, parsed_args, true);
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
				hdb_logger.error(err, true);
			} else {
				console.error(UPGRADE_ERR);
				hdb_logger.error(err, true);
			}
			process.exit(1);
		}

		check_jwt_tokens();
		await checkTransactionLogEnvironmentsExist();
		writeLicenseFromVars();

		// Check user has required permissions to start HDB.
		try {
			install_user_permission.checkPermission();
		} catch (err) {
			hdb_logger.error(err, true);
			console.error(err.message);
			process.exit(1);
		}

		const clustering_enabled = hdb_utils.autoCastBoolean(env.get(terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY));
		const custom_func_enabled = hdb_utils.autoCastBoolean(
			env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY)
		);

		// Run can be called with a --service argument which allows designated services to be started.
		const cmd_args = minimist(process.argv);
		if (!hdb_utils.isEmpty(cmd_args.service)) {
			if (typeof cmd_args.service !== 'string') {
				const service_err_msg = `Run service argument expected a string but received: ${cmd_args.service}`;
				hdb_logger.error(service_err_msg, true);
				console.log(service_err_msg);
				process.exit(1);
			}

			const cmd_args_array = cmd_args.service.split(',');
			for (const args of cmd_args_array) {
				const service = args.toLowerCase();
				if (terms.PROCESS_DESCRIPTORS_VALIDATE[service] === undefined) {
					hdb_logger.error(`Run received unrecognized service command argument: ${service}`, true);
					continue;
				}

				// If custom functions not enabled in settings.js do not start.
				if (service === terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS.toLowerCase() && !custom_func_enabled) {
					hdb_logger.error(`${service} is not enabled in settings`, true);
					continue;
				}

				// If clustering not enabled in settings.js do not start.
				if (service === terms.PROCESS_DESCRIPTORS.CLUSTERING.toLowerCase() && !clustering_enabled) {
					hdb_logger.error(`${service} is not enabled in settings`, true);
					continue;
				}

				await pm2_utils.startService(terms.PROCESS_DESCRIPTORS_VALIDATE[service]);
				const log_msg = `${terms.PROCESS_DESCRIPTORS_VALIDATE[service]} successfully started.`;
				hdb_logger.notify(log_msg, true);
				console.log(log_msg);
			}

			foregroundHandler();
		} else if (clustering_enabled && custom_func_enabled) {
			await pm2_utils.startAllServices();
		} else if (clustering_enabled) {
			await startHdbIpc();
			await pm2_utils.startService(terms.PROCESS_DESCRIPTORS.CLUSTERING);
			await pm2_utils.startService(terms.PROCESS_DESCRIPTORS.CLUSTERING_CONNECTOR);
		} else if (custom_func_enabled) {
			await startHdbIpc();
			await pm2_utils.startService(terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS);
		} else {
			await startHdbIpc();
		}

		// Console log Harper dog logo
		console.log(colors.magenta('' + fs.readFileSync(path.join(__dirname, '../utility/install/ascii_logo.txt'))));
		console.log(colors.magenta(`|------------- HarperDB ${pjson.version} successfully started ------------|`));

		hdb_logger.notify(HDB_STARTED, true);
		foregroundHandler();
	} catch (err) {
		console.error(err);
		hdb_logger.error(err, true);
		process.exit(1);
	}
}

/**
 * Starts HarperDB and IPC servers.
 * @returns {Promise<void>}
 */
async function startHdbIpc() {
	await pm2_utils.startService(terms.PROCESS_DESCRIPTORS.IPC);
	await pm2_utils.startService(terms.PROCESS_DESCRIPTORS.HDB);
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
		const { HARPERDB_FINGERPRINT, HARPERDB_LICENSE } = hdb_utils.assignCMDENVVariables([
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
		hdb_logger.error(ERROR_MSG, true);
	}
}

/**
 * iterates the system schema & all other schemas and makes sure there is a transaction environment for the schema.table
 * @returns {Promise<void>}
 */
async function checkTransactionLogEnvironmentsExist() {
	if (env.getHdbBasePath() !== undefined) {
		hdb_logger.info('Checking Transaction Environments exist', true);

		for (const table_name of Object.keys(SYSTEM_SCHEMA)) {
			await openCreateTransactionEnvironment(terms.SYSTEM_SCHEMA_NAME, table_name);
		}

		let describe_results = await schema_describe.describeAll();

		for (const schema_name of Object.keys(describe_results)) {
			for (const table_name of Object.keys(describe_results[schema_name])) {
				await openCreateTransactionEnvironment(schema_name, table_name);
			}
		}

		hdb_logger.info('Finished checking Transaction Environments exist', true);
	}
}

/**
 * runs the create environment command for the specified schema.table
 * @param {string} schema
 * @param {string} table_name
 * @returns {Promise<void>}
 */
async function openCreateTransactionEnvironment(schema, table_name) {
	try {
		let create_tbl_obj = new CreateTableObject(schema, table_name);
		await lmdb_create_txn_environment(create_tbl_obj);
	} catch (e) {
		let error_msg = `Unable to create the transaction environment for ${schema}.${table_name}, due to: ${e.message}`;
		console.error(error_msg);
		hdb_logger.error(error_msg, true);
	}
}

/**
 * if foreground is passed as an env setting we do not exit the process
 * also if foreground is passed we setup the processExitHandler to call the stop handler which kills the hdb processes
 */
function foregroundHandler() {
	if (!getRunInForeground()) {
		// Exit run process with success code.
		process.exit(0);
	}

	hdb_logger.trace('Running in foreground', true);

	process.on('exit', processExitHandler);

	//catches ctrl+c event
	process.on('SIGINT', processExitHandler);

	// catches "kill pid"
	process.on('SIGUSR1', processExitHandler);
	process.on('SIGUSR2', processExitHandler);

	spawnLogProcess();
}

/**
 * Spawn a pm2 log process
 */
function spawnLogProcess() {
	const proc = spawn('node', [path.resolve(__dirname, '../node_modules/pm2/bin/pm2'), 'logs']);

	proc.on('error', (err) => {
		console.log(err);
		console.error('Failed to start subprocess.');
	});

	proc.stdout.on('data', (data) => {
		console.log(data.toString());
	});

	proc.stderr.on('data', (data) => {
		console.error(data.toString());
	});
}

/**
 * If running in foreground and exit event occurs stop is called
 * @returns {Promise<void>}
 */
async function processExitHandler() {
	if (getRunInForeground()) {
		try {
			await stop.stop();
		} catch (err) {
			console.error(err);
		}
	}
}

module.exports = {
	run: run,
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
		if (err.errno === ENOENT_ERR_CODE) {
			// boot props not found, hdb not installed
			return false;
		}

		hdb_logger.error(`Error checking for HDB install - ${err}`, true);
		throw err;
	}

	return true;
}

function getRunInForeground() {
	const FOREGROUND_ENV = env.get(terms.HDB_SETTINGS_NAMES.RUN_IN_FOREGROUND);
	return FOREGROUND_ENV === 'true' || FOREGROUND_ENV === true || FOREGROUND_ENV === 'TRUE';
}
