'use strict';

/**
 * The upgrade module is used to facilitate the upgrade process for existing instances of HDB that pull down a new version
 * of HDB from NPM that requires a specific upgrade script be run - e.g. there are changes required for the settings.js
 * config file, a data model change requires a re-indexing script is run, etc.
 */

const env = require('../utility/environment/environmentManager.ts');
env.initSync();

const chalk = require('chalk');
const hdbLogger = require('../utility/logging/harper_logger.ts');
const hdbTerms = require('../utility/hdbTerms.ts');
const directivesManager = require('../upgrade/directivesManager.ts');
const installation = require('../utility/installation.ts');
const hdbInfoController = require('../dataLayer/hdbInfoController.ts');
const globalSchema = require('../utility/globalSchema.ts');
const { packageJson } = require('../utility/packageUtils.js');
const promisify = require('util').promisify;
const pSchemaToGlobal = promisify(globalSchema.setSchemaDataToGlobal);
let pm2Utils;

const { UPGRADE_VERSION } = hdbTerms.UPGRADE_JSON_FIELD_NAMES_ENUM;

module.exports = {
	upgrade,
};

/**
 * Runs the upgrade directives, if needed, for an updated version of Harper.
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
	const installed = installation.isHdbInstalled(env, hdbLogger);
	if (!installed) {
		const hdbNotInstalledMsg = 'Harper is not installed. Harper must be installed before running an upgrade.';
		printToLogAndConsole(hdbNotInstalledMsg, hdbTerms.LOG_LEVELS.ERROR);
		process.exit(1);
	}

	let hdbUpgradeInfo = upgradeObj;
	if (!hdbUpgradeInfo) {
		hdbUpgradeInfo = await hdbInfoController.getVersionUpdateInfo();
		if (!hdbUpgradeInfo) {
			console.log('Harper version is current');
			process.exit(0);
		}
	}

	printToLogAndConsole(`This version of Harper is ${packageJson.version}`, hdbTerms.LOG_LEVELS.INFO);

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

	// Upgrade directives run automatically; they do NOT require interactive confirmation.
	// `upgrade()` only runs when an upgrade directive applies (getVersionUpdateInfo returns an
	// object only when hasUpgradesRequired is true), and it runs on the normal `harper run`
	// startup path (bin/run.ts). Blocking on a confirmation prompt there would hang on stdin —
	// or, with no TTY, default to "no" and refuse to start — breaking unattended/scripted
	// starts (systemd, containers, CI). We surface the upgrade as a non-blocking notice instead.
	// (Downgrades still confirm via forceDowngradePrompt in hdbInfoController — running older
	// software on upgraded data is the genuinely risky, lossy direction.)
	printToLogAndConsole(
		`Harper is completing an update to version ${currentHdbVersion}. You can read more about the changes in this upgrade at https://harperdb.io/developers/release-notes/`,
		hdbTerms.LOG_LEVELS.INFO
	);

	await runUpgrade(hdbUpgradeInfo);

	printToLogAndConsole(
		`Harper was successfully upgraded to version ${hdbUpgradeInfo[UPGRADE_VERSION]}`,
		hdbTerms.LOG_LEVELS.INFO
	);
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
