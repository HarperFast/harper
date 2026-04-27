'use strict';

import * as hdbUtil from '../utility/common_utils.js';
import * as log from '../utility/logging/harper_logger.js';
import * as directivesController from './directives/directivesController.js';

export {
	processDirectives,
};

/**
 * Iterates through the directives files to find uninstalled updates and runs the files.
 *
 * @param upgradeObj
 * @returns {Promise<*[]>}
 */
async function processDirectives(upgradeObj: any): Promise<any[]> {
	console.log('Starting upgrade process...');

	let loadedDirectives = directivesController.getVersionsForUpgrade(upgradeObj);
	let upgradeDirectives = getUpgradeDirectivesToInstall(loadedDirectives);

	let allResponses: any[] = [];
	const dirLength = upgradeDirectives.length;
	for (let i = 0; i < dirLength; i++) {
		const vers = upgradeDirectives[i];
		let notifyMsg = `Running upgrade for version ${vers.version}`;
		log.notify(notifyMsg);
		console.log(notifyMsg);

		let syncFuncResponse: any[] = [];
		let asyncFuncResponses: any[] = [];

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
function runSyncFunctions(directiveFunctions: any[]): any[] {
	if (hdbUtil.isEmptyOrZeroLength(directiveFunctions)) {
		log.info('No functions found to run for upgrade');
		return [];
	}
	if (!Array.isArray(directiveFunctions)) {
		log.info('Passed parameter is not an array');
		return [];
	}
	let funcResponses: any[] = [];
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
async function runAsyncFunctions(directiveFunctions: any[]): Promise<any[]> {
	if (hdbUtil.isEmptyOrZeroLength(directiveFunctions)) {
		log.info('No functions found to run for upgrade');
		return [];
	}
	if (!Array.isArray(directiveFunctions)) {
		log.info('Passed parameter is not an array');
		return [];
	}
	let funcResponses: any[] = [];
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
function getUpgradeDirectivesToInstall(loadedDirectives: any[]): any[] {
	if (hdbUtil.isEmptyOrZeroLength(loadedDirectives)) {
		return [];
	}

	let versionModulesToRun: any[] = [];
	for (let vers of loadedDirectives) {
		let module = directivesController.getDirectiveByVersion(vers);
		if (module) {
			versionModulesToRun.push(module);
		}
	}
	return versionModulesToRun;
}
