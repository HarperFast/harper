'use strict';

const hdb_terms = require('../utility/hdbTerms');
const hdb_logger = require('../utility/logging/harper_logger');
const hdb_utils = require('../utility/common_utils');
const assignCMDENVVariables = require('../utility/assignCmdEnvVariables');
const env_mngr = require('../utility/environment/environmentManager');
const minimist = require('minimist');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const config_utils = require('../config/configUtils');
const { HTTP_STATUS_CODES } = hdb_errors;

let pm2_utils;

const RESTART_RESPONSE = `Restarting HarperDB. This may take up to ${hdb_terms.RESTART_TIMEOUT_MS / 1000} seconds.`;
const INVALID_SERVICE_ERR = 'Invalid service';
const MISSING_SERVICE = "'service' is required";
const RESTART_MSG = 'Restarting all services';

module.exports = {
	stop,
	restartProcesses,
	restartService,
};

/**
 * Restart all services or designated services.
 * @returns {Promise<>}
 */
async function restartProcesses() {
	hdb_logger.createLogFile(hdb_terms.PROCESS_LOG_NAMES.CLI, hdb_terms.PROCESS_DESCRIPTORS.STOP);

	try {
		// Requiring the pm2 mod will create the .pm2 dir. This code is here to allow install to set pm2 env vars before that is done.
		if (pm2_utils === undefined) pm2_utils = require('../utility/pm2/utilityFunctions');

		// If restart is called with cmd/env vars we create a backup of config and update config file.
		const parsed_args = assignCMDENVVariables(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
		if (!hdb_utils.isEmptyOrZeroLength(Object.keys(parsed_args))) {
			config_utils.updateConfigValue(undefined, undefined, parsed_args, true);
		}

		const { clustering_enabled, custom_func_enabled } = checkEnvSettings();
		// Restart can be called with a --service argument which allows designated services to be restarted.
		const cmd_args = minimist(process.argv);
		if (!hdb_utils.isEmpty(cmd_args.service)) {
			if (typeof cmd_args.service !== 'string') {
				const service_err_msg = `Restart service argument expected a string but received: ${cmd_args.service}`;
				hdb_logger.error(service_err_msg);
				return service_err_msg;
			}
			const cmd_args_array = cmd_args.service.split(',');
			for (const args of cmd_args_array) {
				const service_req = args.toLowerCase();
				if (hdb_terms.PROCESS_DESCRIPTORS_VALIDATE[service_req] === undefined) {
					console.error(`Restart received unrecognized service command argument: ${service_req}`);
					hdb_logger.error(`Restart received unrecognized service command argument: ${service_req}`);
					continue;
				}

				const service = hdb_terms.PROCESS_DESCRIPTORS_VALIDATE[service_req];
				console.log(`Restarting ${service}`);
				hdb_logger.trace(`Restarting ${service}`);

				if (service === hdb_terms.PROCESS_DESCRIPTORS.PM2_LOGROTATE) {
					await pm2_utils.configureLogRotate();
				} else if (await pm2_utils.isServiceRegistered(service)) {
					// We need to allow for restart to be called on services that arent registered/managed by pm2. If restart is called on a
					// service that isn't registered that service will be started by pm2.

					// If the service is registered but the settings value is not set to enabled, stop the service.
					if (service === hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING && !clustering_enabled) {
						await pm2_utils.stop(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING);
						hdb_logger.trace(`Stopping ${hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING}`);
					} else if (service === hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS && !custom_func_enabled) {
						await pm2_utils.stop(hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS);
						hdb_logger.trace(`Stopping ${hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS}`);
					} else {
						await restartService({ service });
					}
				} else if (service === hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING) {
					if (clustering_enabled) {
						await pm2_utils.startService(service);
						hdb_logger.trace(`Starting ${service}`);
					} else {
						const sc_err_msg = `${service} is not enabled in hdb/setting.js and cannot be restarted.`;
						hdb_logger.error(sc_err_msg);
						console.log(sc_err_msg);
					}
				} else if (service === hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS) {
					if (custom_func_enabled) {
						await pm2_utils.startService(service);
						hdb_logger.trace(`Starting ${service}`);
					} else {
						const cf_err_msg = `${service} is not enabled in hdb/setting.js and cannot be restarted.`;
						hdb_logger.error(cf_err_msg);
						console.log(cf_err_msg);
					}
				} else {
					await pm2_utils.startService(service);
				}

				hdb_logger.notify(`${service} successfully restarted.`);
			}
			return;
		}

		console.log(RESTART_RESPONSE);

		const is_sc_reg = await pm2_utils.isServiceRegistered(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING);
		// If clustering is enabled in setting.js but is not registered to pm2, start service.
		if (clustering_enabled && !is_sc_reg) {
			await pm2_utils.startService(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING);
			await pm2_utils.startService(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_CONNECTOR);
			hdb_logger.trace(`Starting ${hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING}`);
		}

		const is_cf_reg = await pm2_utils.isServiceRegistered(hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS);
		// If custom functions is enabled in setting.js but is not registered to pm2, start service.
		if (custom_func_enabled && !is_cf_reg) {
			await pm2_utils.startService(hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS);
			hdb_logger.trace(`Starting ${hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS}`);
		}

		let exclude_from_restart = [];
		// If clustering is disabled in setting.js and is registered to pm2, stop service.
		if (!clustering_enabled && is_sc_reg) {
			exclude_from_restart.push(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING);
			await pm2_utils.stop(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING);
			await pm2_utils.stop(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_CONNECTOR);
			hdb_logger.trace(`Stopping ${hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING}`);
		}

		// If custom functions is disabled in setting.js and is registered to pm2, stop service.
		if (!custom_func_enabled && is_cf_reg) {
			exclude_from_restart.push(hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS);
			await pm2_utils.stop(hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS);
			hdb_logger.trace(`Stopping ${hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS}`);
		}

		// Start, restart or stop log rotate
		await pm2_utils.configureLogRotate();

		// If no service argument is passed all services are restarted.
		hdb_logger.notify(RESTART_MSG);
		await pm2_utils.restartAllServices(exclude_from_restart);

		return RESTART_RESPONSE;
	} catch (err) {
		let msg = `There was an error restarting HarperDB. ${err}`;
		hdb_logger.error(msg);
		return msg;
	}
}

/**
 * Restarts servers for a specific service.
 * @param json_message
 * @returns {string}
 */
async function restartService(json_message) {
	hdb_logger.createLogFile(hdb_terms.PROCESS_LOG_NAMES.CLI, hdb_terms.PROCESS_DESCRIPTORS.STOP);

	// Requiring the pm2 mod will create the .pm2 dir. This code is here to allow install to set pm2 env vars before that is done.
	if (pm2_utils === undefined) pm2_utils = require('../utility/pm2/utilityFunctions');

	if (hdb_utils.isEmpty(json_message.service)) {
		throw handleHDBError(new Error(), MISSING_SERVICE, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}
	const service_req = json_message.service.toLowerCase();
	if (hdb_terms.PROCESS_DESCRIPTORS_VALIDATE[service_req] === undefined) {
		throw handleHDBError(new Error(), INVALID_SERVICE_ERR, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	const { clustering_enabled, custom_func_enabled } = checkEnvSettings();
	const service = hdb_terms.PROCESS_DESCRIPTORS_VALIDATE[service_req];

	// For clustered services a rolling restart is available.
	if (service === hdb_terms.PROCESS_DESCRIPTORS.HDB) {
		await pm2_utils.reloadStopStart(service);
	} else if (service === hdb_terms.PROCESS_DESCRIPTORS.PM2_LOGROTATE) {
		await pm2_utils.configureLogRotate();
	} else if (
		service === hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS ||
		service === hdb_terms.SERVICES.CUSTOM_FUNCTIONS
	) {
		const is_cf_reg = await pm2_utils.isServiceRegistered(service);
		if (custom_func_enabled) {
			// If the service is registered to pm2 it can be restarted, if it isn't it must me started.
			if (is_cf_reg) {
				await pm2_utils.reloadStopStart(service);
				hdb_logger.trace(`Reloading ${service}`);
			} else {
				await pm2_utils.startService(service);
				hdb_logger.trace(`Starting ${service}`);
			}
		} else if (!custom_func_enabled && is_cf_reg) {
			// If the service is registered but not enabled in settings, stop service.
			await pm2_utils.stop(service);
			hdb_logger.trace(`Stopping ${service}`);
		} else {
			const cf_err_msg = `${service} is not enabled in hdb/setting.js and cannot be restarted.`;
			hdb_logger.error(cf_err_msg);
			throw handleHDBError(new Error(), cf_err_msg, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
		}
	} else if (service === hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING) {
		const is_sc_reg = await pm2_utils.isServiceRegistered(service);
		if (clustering_enabled) {
			// If the service is registered to pm2 it can be restarted, if it isn't it must me started.
			if (is_sc_reg) {
				await pm2_utils.restart(service);
				hdb_logger.trace(`Restarting ${service}`);
			} else {
				await pm2_utils.startService(service);
				hdb_logger.trace(`Starting ${service}`);
			}
		} else if (!clustering_enabled && is_sc_reg) {
			// If the service is registered but not enabled in settings, stop service.
			await pm2_utils.stop(service);
			hdb_logger.trace(`Stopping ${service}`);
		} else {
			const cf_err_msg = `${service} is not enabled in hdb/setting.js and cannot be restarted.`;
			hdb_logger.error(cf_err_msg);
			throw handleHDBError(new Error(), cf_err_msg, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
		}
	} else {
		await pm2_utils.restart(service);
	}

	const restart_msg = `Restarting ${service}`;
	hdb_logger.notify(restart_msg);
	return restart_msg;
}

/**
 * Stop all instances of harperDB running on the system.  If the current logged in user is not root or the installed user
 * this will fail.
 */
async function stop() {
	hdb_logger.createLogFile(hdb_terms.PROCESS_LOG_NAMES.CLI, hdb_terms.PROCESS_DESCRIPTORS.STOP);

	try {
		// Requiring the pm2 mod will create the .pm2 dir. This code is here to allow install to set pm2 env vars before that is done.
		if (pm2_utils === undefined) pm2_utils = require('../utility/pm2/utilityFunctions');

		// Stop can be called with a --service argument which allows designated services to be stopped.
		const cmd_args = minimist(process.argv);
		if (!hdb_utils.isEmpty(cmd_args.service)) {
			if (typeof cmd_args.service !== 'string') {
				const service_err_msg = `Restart service argument expected a string but received: ${cmd_args.service}`;
				hdb_logger.error(service_err_msg);
				console.log(service_err_msg);
			}

			const cmd_args_array = cmd_args.service.split(',');
			for (const args of cmd_args_array) {
				const service = args.toLowerCase();
				if (hdb_terms.PROCESS_DESCRIPTORS_VALIDATE[service] === undefined) {
					hdb_logger.error(`Stop received unrecognized service command argument: ${service}`);
					continue;
				}

				await pm2_utils.stop(hdb_terms.PROCESS_DESCRIPTORS_VALIDATE[service]);
				const log_msg = `${hdb_terms.PROCESS_DESCRIPTORS_VALIDATE[service]} successfully stopped.`;
				hdb_logger.notify(log_msg);
				console.log(log_msg);
			}
		} else {
			// If no service argument is passed all services are stopped.
			console.log('Stopping HarperDB.');
			await pm2_utils.stopAllServices();
			hdb_logger.notify(`HarperDB has stopped`);
		}
	} catch (err) {
		console.error(err);
		throw err;
	}
}

/**
 * Gets the current setting value for clustering and custom functions
 * @returns {{clustering_enabled: boolean, custom_func_enabled: boolean}}
 */
function checkEnvSettings() {
	env_mngr.initSync();
	const sc_env = env_mngr.get(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY).toString().toLowerCase();
	const cf_env = env_mngr.get(hdb_terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY).toString().toLowerCase();
	const clustering_enabled = sc_env === 'true' || sc_env === "'true'";
	const custom_func_enabled = cf_env === 'true' || cf_env === "'true'";

	return {
		clustering_enabled,
		custom_func_enabled,
	};
}
