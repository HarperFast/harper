'use strict';

const path = require('path');
const fs = require('fs-extra');
const PropertiesReader = require('properties-reader');
const UpgradeDirective = require('../UpgradeDirective.js');
const hdbLog = require('../../utility/logging/harper_logger.js');
const { getOldPropsValue } = require('../upgradeUtilities.js');
const { HDB_SETTINGS_NAMES, CONFIG_PARAMS } = require('../../utility/hdbTerms.ts');
const configUtils = require('../../config/configUtils.js');
const env = require('../../utility/environment/environmentManager.js');
const hdbUtils = require('../../utility/common_utils.js');
const terms = require('../../utility/hdbTerms.ts');

let directive310 = new UpgradeDirective('3.1.0');
let directives = [];

/**
 * Removes the logger option from setting as Pino will now be default and only logger.
 * Adds
 * @returns {string}
 */
function updateSettingsFile310() {
	const oldHdbProps = PropertiesReader(env.get(HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
	const settingsUpdateMsg = 'Updating settings file for version 3.1.0';
	console.log(settingsUpdateMsg);
	hdbLog.info(settingsUpdateMsg);

	let newHdbSettingsVals =
		`   ;Settings for the HarperDB process.\n` +
		`\n` +
		`   ;The directory selected during install where the database files reside.\n` +
		`${HDB_SETTINGS_NAMES.HDB_ROOT_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.HDB_ROOT_KEY, oldHdbProps)}\n` +
		`   ;The port the HarperDB REST interface will listen on.\n` +
		`${HDB_SETTINGS_NAMES.SERVER_PORT_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.SERVER_PORT_KEY, oldHdbProps)}\n` +
		`   ;Set to true to enable HTTPS on the HarperDB REST endpoint.  Requires a valid certificate and key.\n` +
		`${HDB_SETTINGS_NAMES.HTTP_SECURE_ENABLED_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.HTTP_SECURE_ENABLED_KEY,
			oldHdbProps
		)}\n` +
		`   ;The path to the SSL certificate used when running with HTTPS enabled.\n` +
		`${HDB_SETTINGS_NAMES.CERT_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.CERT_KEY, oldHdbProps)}\n` +
		`   ;The path to the SSL private key used when running with HTTPS enabled.\n` +
		`${HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY, oldHdbProps)}\n` +
		`   ;Set to true to enable Cross Origin Resource Sharing, which allows requests across a domain.\n` +
		`${HDB_SETTINGS_NAMES.CORS_ENABLED_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.CORS_ENABLED_KEY,
			oldHdbProps
		)}\n` +
		`   ;Allows for setting allowable domains with CORS. Comma separated list.\n` +
		`${HDB_SETTINGS_NAMES.CORS_WHITELIST_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.CORS_WHITELIST_KEY,
			oldHdbProps
		)}\n` +
		`   ;Length of time in milliseconds after which a request will timeout.  Defaults to 120,000 ms (2 minutes).\n` +
		`${HDB_SETTINGS_NAMES.SERVER_TIMEOUT_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.SERVER_TIMEOUT_KEY,
			oldHdbProps,
			true
		)}\n` +
		`   ;The number of milliseconds of inactivity a server needs to wait for additional incoming data, after it has finished writing the last response.  Defaults to 5,000 ms (5 seconds).\n` +
		`${HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY,
			oldHdbProps,
			true
		)}\n` +
		`   ;Limit the amount of time the parser will wait to receive the complete HTTP headers..  Defaults to 60,000 ms (1 minute).\n` +
		`${HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY,
			oldHdbProps,
			true
		)}\n` +
		`   ;Define whether to log to file or not.\n` +
		`${HDB_SETTINGS_NAMES.LOG_TO_FILE} = ${configUtils.getDefaultConfig(CONFIG_PARAMS.LOGGING_FILE)}\n` +
		`   ;Define whether to log to stdout/stderr or not. NOTE HarperDB must run in foreground in order to receive the std stream from HarperDB.\n` +
		`${HDB_SETTINGS_NAMES.LOG_TO_STDSTREAMS} = ${configUtils.getDefaultConfig(CONFIG_PARAMS.LOGGING_STDSTREAMS)}\n` +
		`   ;Set to control amount of logging generated.  Accepted levels are trace, debug, warn, error, fatal.\n` +
		`${HDB_SETTINGS_NAMES.LOG_LEVEL_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.LOG_LEVEL_KEY, oldHdbProps)}\n` +
		`   ;The path where log files will be written. If there is no file name included in the path, the log file will be created by default as 'hdb_log.log' \n` +
		`${HDB_SETTINGS_NAMES.LOG_PATH_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.LOG_PATH_KEY, oldHdbProps)}\n` +
		`   ;Set to true to enable daily log file rotations - each log file name will be prepended with YYYY-MM-DD.\n` +
		`${HDB_SETTINGS_NAMES.LOG_DAILY_ROTATE_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.LOG_DAILY_ROTATE_KEY,
			oldHdbProps
		)}\n` +
		`   ;Set the number of daily log files to maintain when LOG_DAILY_ROTATE is enabled. If no integer value is set, no limit will be set for\n` +
		`   ;daily log files which may consume a large amount of storage depending on your log settings.\n` +
		`${HDB_SETTINGS_NAMES.LOG_MAX_DAILY_FILES_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.LOG_MAX_DAILY_FILES_KEY,
			oldHdbProps
		)}\n` +
		`   ;The environment used by NodeJS.  Setting to production will be the most performant, settings to development will generate more logging.\n` +
		`${HDB_SETTINGS_NAMES.PROPS_ENV_KEY} = ${getOldPropsValue(HDB_SETTINGS_NAMES.PROPS_ENV_KEY, oldHdbProps)}\n` +
		`   ;This allows self signed certificates to be used in clustering.  This is a security risk\n` +
		`   ;as clustering will not validate the cert, so should only be used internally.\n` +
		`   ;The HDB install creates a self signed certificate, if you use that cert this must be set to true.\n` +
		`${HDB_SETTINGS_NAMES.ALLOW_SELF_SIGNED_SSL_CERTS} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.ALLOW_SELF_SIGNED_SSL_CERTS,
			oldHdbProps,
			true
		)}\n` +
		`   ;Set the max number of processes HarperDB will start.  This can also be limited by number of cores and licenses.\n` +
		`${HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES,
			oldHdbProps
		)}\n` +
		`   ;Set to true to enable clustering.  Requires a valid enterprise license.\n` +
		`${HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY,
			oldHdbProps,
			true
		)}\n` +
		`   ;The port that will be used for HarperDB clustering.\n` +
		`${HDB_SETTINGS_NAMES.CLUSTERING_PORT_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.CLUSTERING_PORT_KEY,
			oldHdbProps
		)}\n` +
		`   ;The name of this node in your HarperDB cluster topology.  This must be a value unique from the rest of your cluster node names.\n` +
		`${HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY,
			oldHdbProps
		)}\n` +
		`   ;The user used to connect to other instances of HarperDB, this user must have a role of cluster_user. \n` +
		`${HDB_SETTINGS_NAMES.CLUSTERING_USER_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.CLUSTERING_USER_KEY,
			oldHdbProps
		)}\n` +
		`   ;Defines if this instance does not record transactions. Note, if Clustering is enabled and Transaction Log is disabled your nodes will not catch up.  \n` +
		`${HDB_SETTINGS_NAMES.DISABLE_TRANSACTION_LOG_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.DISABLE_TRANSACTION_LOG_KEY,
			oldHdbProps,
			true
		)}\n` +
		`   ;Defines the length of time an operation token will be valid until it expires. Example values: https://github.com/vercel/ms  \n` +
		`${HDB_SETTINGS_NAMES.OPERATION_TOKEN_TIMEOUT_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.OPERATION_TOKEN_TIMEOUT_KEY,
			oldHdbProps,
			true
		)}\n` +
		`   ;Defines the length of time a refresh token will be valid until it expires. Example values: https://github.com/vercel/ms  \n` +
		`${HDB_SETTINGS_NAMES.REFRESH_TOKEN_TIMEOUT_KEY} = ${getOldPropsValue(
			HDB_SETTINGS_NAMES.REFRESH_TOKEN_TIMEOUT_KEY,
			oldHdbProps,
			true
		)}\n` +
		`   ;The port the IPC server will run on.\n` +
		`${HDB_SETTINGS_NAMES.IPC_SERVER_PORT} = ${configUtils.getDefaultConfig(CONFIG_PARAMS.IPC_NETWORK_PORT)}\n` +
		`   ;Run HDB in the foreground.\n` +
		`${HDB_SETTINGS_NAMES.RUN_IN_FOREGROUND} = ${configUtils.getDefaultConfig(
			CONFIG_PARAMS.OPERATIONSAPI_FOREGROUND
		)}\n` +
		`   ;Set to true to enable custom API endpoints.  Requires a valid enterprise license.  \n` +
		`${HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY} = ${configUtils.getDefaultConfig(
			CONFIG_PARAMS.CUSTOMFUNCTIONS_ENABLED
		)}\n` +
		`   ;The port used to access the custom functions server.\n` +
		`${HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_PORT_KEY} = ${configUtils.getDefaultConfig(CONFIG_PARAMS.HTTP_PORT)}\n` +
		`   ;The path to the folder containing HarperDB custom function files.\n` +
		`${HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY} = ${path.join(
			getOldPropsValue(HDB_SETTINGS_NAMES.HDB_ROOT_KEY, oldHdbProps),
			'custom_functions'
		)}\n` +
		`   ;Set the max number of processes HarperDB will start for the Custom Functions server\n` +
		`${HDB_SETTINGS_NAMES.MAX_CUSTOM_FUNCTION_PROCESSES} = ${configUtils.getDefaultConfig(
			CONFIG_PARAMS.HTTP_THREADS
		)}\n`;
	const settings_path = env.get('settings_path');
	const settingsDir = path.dirname(settings_path);
	const settingsBackupPath = path.join(settingsDir, '3_1_0_upgrade_settings.bak');

	try {
		//create backup of old settings file
		hdbLog.info(`Backing up old settings file to: ${settingsBackupPath}`);
		fs.copySync(settings_path, settingsBackupPath);
	} catch (err) {
		hdbLog.error(err);
		console.error(
			'There was a problem writing the backup for the old settings file.  Please check the log for details.'
		);
		throw err;
	}

	try {
		hdbLog.info(`New settings file values for 3.1.0 upgrade:`, newHdbSettingsVals);
		hdbLog.info(`Creating new/upgraded settings file at '${settings_path}'`);

		fs.writeFileSync(settings_path, newHdbSettingsVals);
		hdbLog.info('Updating env variables with new settings values');
	} catch (err) {
		//if there was an error writing the new file, we will do our best to reset the original settings file
		console.error('There was a problem writing the new settings file. Please check the log for details.');
		hdbLog.error("Attempting to reset the settings file to its original state.  Use the '.bak' file if this fails.");
		hdbLog.error(err);
		fs.copySync(settingsBackupPath, settings_path);
		throw err;
	}

	// load new props into env
	env.initSync();

	const upgradeSuccessMsg = 'New settings file for 3.1.0 upgrade successfully created.';
	console.log(upgradeSuccessMsg);
	hdbLog.info(upgradeSuccessMsg);

	return upgradeSuccessMsg;
}

function moveLicenseFiles() {
	const LICENSE_FILE_PATH = path.join(
		hdbUtils.getHomeDir(),
		terms.HDB_HOME_DIR_NAME,
		terms.LICENSE_KEY_DIR_NAME,
		terms.LICENSE_FILE_NAME
	);
	const REG_FILE_PATH = path.join(
		hdbUtils.getHomeDir(),
		terms.HDB_HOME_DIR_NAME,
		terms.LICENSE_KEY_DIR_NAME,
		terms.REG_KEY_FILE_NAME
	);
	const HDB_LICENSE_DIR = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.LICENSE_FILE_NAME);
	const NEW_LICENSE_FILE_PATH = path.join(HDB_LICENSE_DIR, terms.LICENSE_FILE_NAME);
	const NEW_REG_FILE_PATH = path.join(HDB_LICENSE_DIR, terms.REG_KEY_FILE_NAME);

	const settingsUpdateMsg = 'Move license files for version 3.1.0';
	console.log(settingsUpdateMsg);
	hdbLog.info(settingsUpdateMsg);

	const createLicenseDirMsg = 'Creating .license directory';
	console.log(createLicenseDirMsg);
	hdbLog.info(createLicenseDirMsg);
	fs.mkdirpSync(HDB_LICENSE_DIR);

	try {
		fs.accessSync(LICENSE_FILE_PATH);

		try {
			const moveLicenseMsg = 'Moving licence file';
			console.log(moveLicenseMsg);
			hdbLog.info(moveLicenseMsg);

			fs.moveSync(LICENSE_FILE_PATH, NEW_LICENSE_FILE_PATH);

			const successMoveLicenseMsg = 'License file successfully moved.';
			console.log(successMoveLicenseMsg);
			hdbLog.info(successMoveLicenseMsg);
		} catch (e) {
			const moveLicenseFailed = `moving license file failed`;
			console.error(moveLicenseFailed);
			hdbLog.error(moveLicenseFailed);
		}
	} catch (e) {
		const licenseDirNoExist = `license file '${LICENSE_FILE_PATH}' does not exist.`;
		console.warn(licenseDirNoExist);
		hdbLog.warn(licenseDirNoExist);
	}

	try {
		fs.accessSync(REG_FILE_PATH);

		try {
			const moveRegMsg = 'Moving registration file';
			console.log(moveRegMsg);
			hdbLog.info(moveRegMsg);

			fs.moveSync(REG_FILE_PATH, NEW_REG_FILE_PATH);

			const successMoveRegMsg = 'Registration file successfully moved.';
			console.log(successMoveRegMsg);
			hdbLog.info(successMoveRegMsg);
		} catch (e) {
			const moveRegistrationFailed = `moving registration file failed`;
			console.error(moveRegistrationFailed);
			hdbLog.error(moveRegistrationFailed);
		}
	} catch (e) {
		const registrationFileNoExist = `registration file '${REG_FILE_PATH}' does not exist.`;
		console.warn(registrationFileNoExist);
		hdbLog.warn(registrationFileNoExist);
	}
}

directive310.sync_functions.push(updateSettingsFile310);
directive310.sync_functions.push(moveLicenseFiles);

directives.push(directive310);

module.exports = directives;
