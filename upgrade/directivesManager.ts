'use strict';

import * as hdbUtil from '../utility/common_utils.ts';
import * as hdbTerms from '../utility/hdbTerms.ts';
import log from '../utility/logging/harper_logger.ts';
import * as directivesController from './directives/directivesController.ts';

const { DATA_VERSION, UPGRADE_VERSION } = hdbTerms.UPGRADE_JSON_FIELD_NAMES_ENUM;

/**
 * Build the upgrade-process header line. Surfaces the real data -> software transition and the
 * migration count so the per-migration directive version below isn't misread as a downgrade: a
 * migration's version is the release that *introduced* it, not the software version being installed,
 * so a migration tagged 5.1.0 can run while installing a later release (e.g. 5.1.7).
 */
export function formatUpgradeHeader(dataVersion: any, upgradeVersion: any, migrationCount: number) {
	if (migrationCount === 0) {
		return `Starting upgrade process: no data migrations to apply (data ${dataVersion} -> software ${upgradeVersion}).`;
	}
	const plural = migrationCount === 1 ? '' : 's';
	return `Starting upgrade process: applying ${migrationCount} data migration${plural} to bring data from ${dataVersion} up to software ${upgradeVersion}.`;
}

/** Build a single migration's log line: which migration, the release that introduced it, and what it does. */
export function formatMigrationLine(position: number, total: number, version: any, description?: any) {
	const detail = description ? `: ${description}` : '';
	return `Applying migration ${position} of ${total} (introduced in ${version})${detail}`;
}

/**
 * Iterates through the directives files to find uninstalled updates and runs the files.
 *
 * @param upgradeObj
 * @returns {Promise<*[]>}
 */
export async function processDirectives(upgradeObj: any) {
	const dataVersion = upgradeObj?.[DATA_VERSION];
	const upgradeVersion = upgradeObj?.[UPGRADE_VERSION];

	let loadedDirectives = directivesController.getVersionsForUpgrade(upgradeObj);
	let upgradeDirectives = getUpgradeDirectivesToInstall(loadedDirectives);

	const dirLength = upgradeDirectives.length;

	const header = formatUpgradeHeader(dataVersion, upgradeVersion, dirLength);
	log.notify(header);
	console.log(header);

	let allResponses = [];
	for (let i = 0; i < dirLength; i++) {
		const vers = upgradeDirectives[i];
		let notifyMsg = formatMigrationLine(i + 1, dirLength, vers.version, vers.description);
		log.notify(notifyMsg);
		console.log(notifyMsg);

		let syncFuncResponse = [];
		let asyncFuncResponses = [];

		// Run sync functions for upgrade
		try {
			syncFuncResponse = runSyncFunctions(vers.sync_functions);
		} catch (e) {
			log.error(`Error while running an upgrade script for ${vers.version}`);
			throw e;
		}

		// Run async functions for upgrade
		try {
			asyncFuncResponses = await runAsyncFunctions(vers.async_functions);
		} catch (e) {
			log.error(`Error while running an upgrade script for ${vers.version}`);
			throw e;
		}

		allResponses.push(...syncFuncResponse, ...asyncFuncResponses);
	}

	return allResponses;
}

/**
 * Runs sync functions specified in a directive object.
 *
 * @param directiveFunctions - Array of sync functions to run
 * @returns - Array of responses from function calls
 */
function runSyncFunctions(directiveFunctions: any) {
	if (hdbUtil.isEmptyOrZeroLength(directiveFunctions)) {
		log.info('No functions found to run for upgrade');
		return [];
	}
	if (!Array.isArray(directiveFunctions)) {
		log.info('Passed parameter is not an array');
		return [];
	}
	let funcResponses = [];
	for (let func of directiveFunctions) {
		log.info(`Running function ${func.name}`);
		if (!(func instanceof Function)) {
			log.info('Variable being processed is not a function');
			continue;
		}

		const response = func();
		log.info(response);
		funcResponses.push(response);
	}

	return funcResponses;
}

/**
 * Runs async functions specified in a directive object.
 *
 * @param directiveFunctions - Array of async functions to run
 * @returns - Array of responses from async function calls
 */
async function runAsyncFunctions(directiveFunctions: any) {
	if (hdbUtil.isEmptyOrZeroLength(directiveFunctions)) {
		log.info('No functions found to run for upgrade');
		return [];
	}
	if (!Array.isArray(directiveFunctions)) {
		log.info('Passed parameter is not an array');
		return [];
	}
	let funcResponses = [];
	const funcsLength = directiveFunctions.length;
	for (let i = 0; i < funcsLength; i++) {
		const func = directiveFunctions[i];
		log.info(`Running function ${func.name}`);
		if (!(func instanceof Function)) {
			log.info('Variable being processed is not a function');
			continue;
		}

		const response = await func();
		log.info(response);
		funcResponses.push(response);
	}
	return funcResponses;
}

/**
 * Based on the current version, find all upgrade directives that need to be installed to make this installation current.
 * Returns the install directives array sorted from lowest to highest version number.
 *
 * @param currVersionNum - The current version of HDB.
 * @returns {Array}
 */
function getUpgradeDirectivesToInstall(loadedDirectives: any) {
	if (hdbUtil.isEmptyOrZeroLength(loadedDirectives)) {
		return [];
	}

	let versionModulesToRun = [];
	for (let vers of loadedDirectives) {
		let module = directivesController.getDirectiveByVersion(vers);
		if (module) {
			versionModulesToRun.push(module);
		}
	}
	return versionModulesToRun;
}
