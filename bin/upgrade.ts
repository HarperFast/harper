/**
 * The upgrade module is used to facilitate the upgrade process for existing instances of HDB that pull down a new version
 * of HDB from NPM that requires a specific upgrade script be run - e.g. there are changes required for the settings.js
 * config file, a data model change requires a re-indexing script is run, etc.
 */

import * as env from '../utility/environment/environmentManager.ts';

import chalk from 'chalk';
import _hdbLogger from '../utility/logging/harper_logger.ts';
const hdbLogger = _hdbLogger;
import * as hdbTerms from '../utility/hdbTerms.ts';
import * as directivesManager from '../upgrade/directivesManager.ts';
import * as installation from '../utility/installation.ts';
import * as hdbInfoController from '../dataLayer/hdbInfoController.ts';
import * as upgradePrompt from '../upgrade/upgradePrompt.ts';
import * as globalSchema from '../utility/globalSchema.ts';
import { packageJson } from '../utility/packageUtils.js';
import { promisify } from 'util';
const pSchemaToGlobal = promisify(globalSchema.setSchemaDataToGlobal);
let pm2Utils;

const { UPGRADE_VERSION } = hdbTerms.UPGRADE_JSON_FIELD_NAMES_ENUM;

export { upgrade };
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
	if (pm2Utils === undefined) pm2Utils = await import('../utility/processManagement/processManagement.ts');

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
		console.log('Cancelled upgrade, closing Harper');
		process.exit(exitCode);
	}

	hdbLogger.info(`Starting upgrade to version ${currentHdbVersion}`);

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
