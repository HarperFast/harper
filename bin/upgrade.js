'use strict';

/**
 * The upgrade module is used to facilitate the upgrade process for existing instances of HDB that pull down a new version
 * of HDB from NPM that requires a specific upgrade script be run - e.g. there are changes required for the settings.js
 * config file, a data model change requires a re-indexing script is run, etc.
 */

const env = require('../utility/environment/environmentManager.js');
env.initSync();

const chalk = require('chalk');
const hdbLogger = require('../utility/logging/harper_logger.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const directivesManager = require('../upgrade/directivesManager.js');
const hdbUtils = require('../utility/common_utils.js');
const hdbInfoController = require('../dataLayer/hdbInfoController.js');
const upgradePrompt = require('../upgrade/upgradePrompt.js');
const psList = require('../utility/psList.js');
const globalSchema = require('../utility/globalSchema.js');
const { packageJson } = require('../utility/packageUtils.js');
const promisify = require('util').promisify;
const pSchemaToGlobal = promisify(globalSchema.setSchemaDataToGlobal);
let pm2Utils;

const { UPGRADE_VERSION } = hdbTerms.UPGRADE_JSON_FIELD_NAMES_ENUM;

module.exports = {
	upgrade,
};

/**
 * Runs the upgrade directives, if needed, for an updated version of HarperDB.
 *
 * @param upgradeObj - optional
 * @returns {Promise<void>}
 */
async function upgrade(upgradeObj) {
	await pSchemaToGlobal();

	// Requiring the processManagement mod will create the .pm2 dir. This code is here to allow install to set
	// pm2 env vars before that is done.
	if (pm2Utils === undefined) pm2Utils = require('../utility/processManagement/processManagement.js');

	//We have to make sure HDB is installed before doing anything else
	const installed = await hdbUtils.isHdbInstalled(env, hdbLogger);
	if (!installed) {
		const hdbNotInstalledMsg = 'Harper is not installed. Harper must be installed before running an upgrade.';
		printToLogAndConsole(hdbNotInstalledMsg, hdbTerms.LOG_LEVELS.ERROR);
		process.exit(1);
	}

	let hdbUpgradeInfo = upgradeObj;
	if (!hdbUpgradeInfo) {
		hdbUpgradeInfo = await hdbInfoController.getVersionUpdateInfo();
		if (!hdbUpgradeInfo) {
			console.log('HarperDB version is current');
			process.exit(0);
		}
	}

	printToLogAndConsole(`This version of HarperDB is ${packageJson.version}`, hdbTerms.LOG_LEVELS.INFO);

	//The upgrade version should always be included in the hdbUpgradeInfo object returned from the getVersion function
	// above but testing for it and using the version from package.json just in case it is not
	const currentHdbVersion = hdbUpgradeInfo[UPGRADE_VERSION] ?? packageJson.version;
	if (!currentHdbVersion) {
		console.log(
			`Current Version field missing from the package.json file.  Cannot continue with upgrade.  If you need support, please contact ${hdbTerms.HDB_SUPPORT_ADDRESS}`
		);
		hdbLogger.notify('Missing new version field from upgrade info object');
		process.exit(1);
	}

	// check if already running, ends process if error caught.
	await checkIfRunning();

	let startUpgrade;

	let exitCode = 0;
	try {
		startUpgrade = await upgradePrompt.forceUpdatePrompt(hdbUpgradeInfo);
	} catch (err) {
		hdbLogger.error('There was an error when prompting user about upgrade.');
		hdbLogger.error(err);
		startUpgrade = false;
		exitCode = 1;
	}

	if (!startUpgrade) {
		console.log('Cancelled upgrade, closing HarperDB');
		process.exit(exitCode);
	}

	hdbLogger.info(`Starting upgrade to version ${currentHdbVersion}`);

	await runUpgrade(hdbUpgradeInfo);

	printToLogAndConsole(
		`HarperDB was successfully upgraded to version ${hdbUpgradeInfo[UPGRADE_VERSION]}`,
		hdbTerms.LOG_LEVELS.INFO
	);
}

/**
 * Check to see if an instance of HDB is running. Throws an error if running, otherwise it will just return to resolve the promise.
 * @throws
 */
async function checkIfRunning() {
	let hdbRunning = false;

	// This is here to accommodate any HDB process that might have been started with old versions of HDB that dont use processManagement.
	const listHdbServer = await psList.findPs(hdbTerms.HDB_PROC_NAME);
	if (!hdbUtils.isEmptyOrZeroLength(listHdbServer)) {
		hdbRunning = true;
	}

	if (!hdbRunning) {
		// This is here to accommodate any HDB process that might have been started with old versions of HDB that dont use processManagement.
		const listHdbExpress = await psList.findPs('hdb_express');
		if (!hdbUtils.isEmptyOrZeroLength(listHdbExpress)) {
			hdbRunning = true;
		}
	}

	if (!hdbRunning) {
		const processList = await pm2Utils.list();
		if (!hdbUtils.isEmptyOrZeroLength(processList)) {
			hdbRunning = true;
		}
	}

	if (hdbRunning) {
		let runErr =
			"HarperDB is running, please stop all HarperDB services with 'harperdb stop' and run the upgrade command again.";
		console.log(chalk.red(runErr));
		hdbLogger.error(runErr);
		process.exit(1);
	}
}

/**
 * This function is called during an upgrade to execute the applicable upgrade directives based on the data and current
 * version info passed within the `upgradeObj` argument.  After the upgrade is completed, a new record is inserted into
 * the hdbInfo table to track the version info for the instance's data and software.
 *
 * @param upgradeObj
 * @returns {Promise<void>}
 */
async function runUpgrade(upgradeObj) {
	try {
		await directivesManager.processDirectives(upgradeObj);
	} catch (err) {
		printToLogAndConsole(
			'There was an error during the data upgrade.  Please check the logs.',
			hdbTerms.LOG_LEVELS.ERROR
		);
		throw err;
	}

	try {
		await hdbInfoController.insertHdbUpgradeInfo(upgradeObj[UPGRADE_VERSION]);
	} catch (err) {
		hdbLogger.error("Error updating the 'hdb_info' system table.");
		hdbLogger.error(err);
	}
}

function printToLogAndConsole(msg, logLevel = undefined) {
	if (!logLevel) {
		logLevel = hdbLogger.info;
	}
	hdbLogger[logLevel](msg);
	console.log(chalk.magenta(msg));
}
