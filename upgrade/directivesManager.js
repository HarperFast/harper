'use strict';

const hdb_util = require('../utility/common_utils');
const log = require('../utility/logging/harper_logger');
const directivesController = require('./directives/directivesController');

module.exports = {
	processDirectives,
};

/**
 * Iterates through the directives files to find uninstalled updates and runs the files.
 *
 * @param upgrade_obj
 * @returns {Promise<*[]>}
 */
async function processDirectives(upgrade_obj) {
	console.log('Starting upgrade process...');

	let loaded_directives = directivesController.getVersionsForUpgrade(upgrade_obj);
	let upgrade_directives = getUpgradeDirectivesToInstall(loaded_directives);

	let all_responses = [];
	const dir_length = upgrade_directives.length;
	for (let i = 0; i < dir_length; i++) {
		const vers = upgrade_directives[i];
		let notify_msg = `Running upgrade for version ${vers.version}`;
		log.notify(notify_msg);
		console.log(notify_msg);

		let sync_func_response = [];
		let async_func_responses = [];

		// Run sync functions for upgrade
		try {
			sync_func_response = runSyncFunctions(vers.sync_functions);
		} catch (e) {
			log.error(`Error while running a settings upgrade script for ${vers.version}: ` + e);
			throw e;
		}

		// Run async functions for upgrade
		try {
			async_func_responses = await runAsyncFunctions(vers.async_functions);
		} catch (e) {
			log.error(`Error while running an upgrade script for ${vers.version}: ` + e);
			throw e;
		}

		all_responses.push(...sync_func_response, ...async_func_responses);
	}

	return all_responses;
}

/**
 * Runs sync functions specified in a directive object.
 *
 * @param directive_functions - Array of sync functions to run
 * @returns - Array of responses from function calls
 */
function runSyncFunctions(directive_functions) {
	if (hdb_util.isEmptyOrZeroLength(directive_functions)) {
		log.info('No functions found to run for upgrade');
		return [];
	}
	if (!Array.isArray(directive_functions)) {
		log.info('Passed parameter is not an array');
		return [];
	}
	let func_responses = [];
	for (let func of directive_functions) {
		log.info(`Running function ${func.name}`);
		if (!(func instanceof Function)) {
			log.info('Variable being processed is not a function');
			continue;
		}
		try {
			const response = func();
			log.info(response);
			func_responses.push(response);
		} catch (e) {
			log.error(e);
			// Right now assume any functions that need to be run are critical to a successful upgrade, so fail completely
			// if any of them fail.
			throw e;
		}
	}

	return func_responses;
}

/**
 * Runs async functions specified in a directive object.
 *
 * @param directive_functions - Array of async functions to run
 * @returns - Array of responses from async function calls
 */
async function runAsyncFunctions(directive_functions) {
	if (hdb_util.isEmptyOrZeroLength(directive_functions)) {
		log.info('No functions found to run for upgrade');
		return [];
	}
	if (!Array.isArray(directive_functions)) {
		log.info('Passed parameter is not an array');
		return [];
	}
	let func_responses = [];
	const funcs_length = directive_functions.length;
	for (let i = 0; i < funcs_length; i++) {
		const func = directive_functions[i];
		log.info(`Running function ${func.name}`);
		if (!(func instanceof Function)) {
			log.info('Variable being processed is not a function');
			continue;
		}
		try {
			const response = await func();
			log.info(response);
			func_responses.push(response);
		} catch (e) {
			log.error(e);
			// Right now assume any functions that need to be run are critical to a successful upgrade, so fail completely
			// if any of them fail.
			throw e;
		}
	}
	return func_responses;
}

/**
 * Based on the current version, find all upgrade directives that need to be installed to make this installation current.
 * Returns the install directives array sorted from lowest to highest version number.
 *
 * @param curr_version_num - The current version of HDB.
 * @returns {Array}
 */
function getUpgradeDirectivesToInstall(loaded_directives) {
	if (hdb_util.isEmptyOrZeroLength(loaded_directives)) {
		return [];
	}

	let version_modules_to_run = [];
	for (let vers of loaded_directives) {
		let module = directivesController.getDirectiveByVersion(vers);
		if (module) {
			version_modules_to_run.push(module);
		}
	}
	return version_modules_to_run;
}
