'use strict';

/**
 * The upgrade module is used to facilitate the upgrade process for existing instances of HDB that pull down a new version
 * of HDB from NPM that requires a specific upgrade script be run - e.g. there are changes required for the settings.js
 * config file, a data model change requires a re-indexing script is run, etc.
 */

const env = require('../utility/environment/environmentManager');
env.initSync();

const chalk = require('chalk');
const fs = require('fs-extra');
const hdb_logger = require('../utility/logging/harper_logger');
const hdb_terms = require('../utility/hdbTerms');
const directivesManager = require('../upgrade/directivesManager');
const hdb_utils = require('../utility/common_utils');
const hdbInfoController = require('../dataLayer/hdbInfoController');
const upgradePrompt = require('../upgrade/upgradePrompt');
const ps_list = require('../utility/psList');
const global_schema = require('../utility/globalSchema');
const { packageJson } = require('../utility/packageUtils');
const promisify = require('util').promisify;
const p_schema_to_global = promisify(global_schema.setSchemaDataToGlobal);
let pm2_utils;

const { UPGRADE_VERSION } = hdb_terms.UPGRADE_JSON_FIELD_NAMES_ENUM;

module.exports = {
	upgrade,
};

/**
 * Runs the upgrade directives, if needed, for an updated version of HarperDB.
 *
 * @param upgrade_obj - optional
 * @returns {Promise<void>}
 */
async function upgrade(upgrade_obj) {
	await p_schema_to_global();

	// Requiring the processManagement mod will create the .pm2 dir. This code is here to allow install to set
	// pm2 env vars before that is done.
	if (pm2_utils === undefined) pm2_utils = require('../utility/processManagement/processManagement');

	//We have to make sure HDB is installed before doing anything else
	if (!fs.existsSync(env.get(env.BOOT_PROPS_FILE_PATH))) {
		const hdb_not_found_msg = 'The hdb_boot_properties file was not found. Please install HDB.';
		printToLogAndConsole(hdb_not_found_msg, hdb_terms.LOG_LEVELS.ERROR);
		process.exit(1);
	}

	if (!fs.existsSync(env.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY))) {
		const hdb_not_installed_msg = 'The hdb settings file was not found. Please make sure HDB is installed.';
		printToLogAndConsole(hdb_not_installed_msg, hdb_terms.LOG_LEVELS.ERROR);
		process.exit(1);
	}

	let hdb_upgrade_info = upgrade_obj;
	if (!hdb_upgrade_info) {
		hdb_upgrade_info = await hdbInfoController.getVersionUpdateInfo();
		if (!hdb_upgrade_info) {
			console.log('HarperDB version is current');
			process.exit(0);
		}
	}

	printToLogAndConsole(`This version of HarperDB is ${packageJson.version}`, hdb_terms.LOG_LEVELS.INFO);

	//The upgrade version should always be included in the hdb_upgrade_info object returned from the getVersion function
	// above but testing for it and using the version from package.json just in case it is not
	const current_hdb_version = hdb_upgrade_info[UPGRADE_VERSION] ?? packageJson.version;
	if (!current_hdb_version) {
		console.log(
			`Current Version field missing from the package.json file.  Cannot continue with upgrade.  If you need support, please contact ${hdb_terms.HDB_SUPPORT_ADDRESS}`
		);
		hdb_logger.notify('Missing new version field from upgrade info object');
		process.exit(1);
	}

	// check if already running, ends process if error caught.
	await checkIfRunning();

	let start_upgrade;

	let exit_code = 0;
	try {
		start_upgrade = await upgradePrompt.forceUpdatePrompt(hdb_upgrade_info);
	} catch (err) {
		hdb_logger.error('There was an error when prompting user about upgrade.');
		hdb_logger.error(err);
		start_upgrade = false;
		exit_code = 1;
	}

	if (!start_upgrade) {
		console.log('Cancelled upgrade, closing HarperDB');
		process.exit(exit_code);
	}

	hdb_logger.info(`Starting upgrade to version ${current_hdb_version}`);

	await runUpgrade(hdb_upgrade_info);

	printToLogAndConsole(
		`HarperDB was successfully upgraded to version ${hdb_upgrade_info[UPGRADE_VERSION]}`,
		hdb_terms.LOG_LEVELS.INFO
	);
}

/**
 * Check to see if an instance of HDB is running. Throws an error if running, otherwise it will just return to resolve the promise.
 * @throws
 */
async function checkIfRunning() {
	let hdb_running = false;

	// This is here to accommodate any HDB process that might have been started with old versions of HDB that dont use processManagement.
	const list_hdb_server = await ps_list.findPs(hdb_terms.HDB_PROC_NAME);
	if (!hdb_utils.isEmptyOrZeroLength(list_hdb_server)) {
		hdb_running = true;
	}

	if (!hdb_running) {
		// This is here to accommodate any HDB process that might have been started with old versions of HDB that dont use processManagement.
		const list_hdb_express = await ps_list.findPs('hdb_express');
		if (!hdb_utils.isEmptyOrZeroLength(list_hdb_express)) {
			hdb_running = true;
		}
	}

	if (!hdb_running) {
		const process_list = await pm2_utils.list();
		if (!hdb_utils.isEmptyOrZeroLength(process_list)) {
			hdb_running = true;
		}
	}

	if (hdb_running) {
		let run_err =
			"HarperDB is running, please stop all HarperDB services with 'harperdb stop' and run the upgrade command again.";
		console.log(chalk.red(run_err));
		hdb_logger.error(run_err);
		process.exit(1);
	}
}

/**
 * This function is called during an upgrade to execute the applicable upgrade directives based on the data and current
 * version info passed within the `upgrade_obj` argument.  After the upgrade is completed, a new record is inserted into
 * the hdb_info table to track the version info for the instance's data and software.
 *
 * @param upgrade_obj
 * @returns {Promise<void>}
 */
async function runUpgrade(upgrade_obj) {
	try {
		await directivesManager.processDirectives(upgrade_obj);
	} catch (err) {
		printToLogAndConsole(
			'There was an error during the data upgrade.  Please check the logs.',
			hdb_terms.LOG_LEVELS.ERROR
		);
		throw err;
	}

	try {
		await hdbInfoController.insertHdbUpgradeInfo(upgrade_obj[UPGRADE_VERSION]);
	} catch (err) {
		hdb_logger.error("Error updating the 'hdb_info' system table.");
		hdb_logger.error(err);
	}
}

function printToLogAndConsole(msg, log_level = undefined) {
	if (!log_level) {
		log_level = hdb_logger.info;
	}
	hdb_logger[log_level](msg);
	console.log(chalk.magenta(msg));
}
