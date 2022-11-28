'use strict';

const hdb_terms = require('../utility/hdbTerms');
const hdb_logger = require('../utility/logging/harper_logger');
const hdb_utils = require('../utility/common_utils');
const assignCMDENVVariables = require('../utility/assignCmdEnvVariables');
const nats_config = require('../server/nats/utility/natsConfig');
const nats_utils = require('../server/nats/utility/natsUtils');
const nats_terms = require('../server/nats/utility/natsTerms');
const minimist = require('minimist');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const config_utils = require('../config/configUtils');
const { HTTP_STATUS_CODES } = hdb_errors;

let pm2_utils;

const RESTART_RESPONSE = `Restarting HarperDB. This may take up to ${hdb_terms.RESTART_TIMEOUT_MS / 1000} seconds.`;
const RESTART_RUNNING_RESPONSE =
	'HarperDB is currently restarting and must complete before another HarperDB restart can be initialized.';
const INVALID_SERVICE_ERR = 'Invalid service';
const MISSING_SERVICE = "'service' is required";
const RESTART_MSG = 'Restarting all services';
const CLUSTERING_NOT_ENABLED_ERR = 'Clustering is not enabled so cannot be restarted';

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
	// This is here to accommodate requests from the CLI. Stop can also be called
	// from the API, in that case logging will be handled by pm2.
	hdb_logger.createLogFile(hdb_terms.PROCESS_LOG_NAMES.CLI, hdb_terms.PROCESS_DESCRIPTORS.STOP);

	try {
		// Requiring the pm2 mod will create the .pm2 dir. This code is here to allow install to set pm2 env vars before that is done.
		if (pm2_utils === undefined) pm2_utils = require('../utility/pm2/utilityFunctions');

		// If restart is called with cmd/env vars we create a backup of config and update config file.
		const parsed_args = assignCMDENVVariables(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
		if (!hdb_utils.isEmptyOrZeroLength(Object.keys(parsed_args))) {
			config_utils.updateConfigValue(undefined, undefined, parsed_args, true, true);
		}

		const clustering_enabled = config_utils.getConfigFromFile(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED);
		const custom_func_enabled = config_utils.getConfigFromFile(hdb_terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_ENABLED);
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

				// Check to see if the HDB restart script is running, if it is do not restart HDB
				if (
					service_req === hdb_terms.HDB_PROC_DESCRIPTOR.toLowerCase() &&
					(await pm2_utils.isHdbRestartRunning()) === true
				) {
					hdb_logger.notify(RESTART_RUNNING_RESPONSE);
					console.error(RESTART_RUNNING_RESPONSE);
					continue;
				}

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
				} else if (service_req.toLowerCase().includes('clustering')) {
					await restartClustering(service_req);
				} else if (await pm2_utils.isServiceRegistered(service)) {
					// We need to allow for restart to be called on services that arent registered/managed by pm2. If restart is called on a
					// service that isn't registered that service will be started by pm2.

					// If the service is registered but the settings value is not set to enabled, stop the service.
					if (service === hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS && !custom_func_enabled) {
						await pm2_utils.stop(hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS);
						hdb_logger.trace(`Stopping ${hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS}`);
					} else {
						await restartService({ service });
					}
				} else if (service === hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS) {
					if (custom_func_enabled) {
						await pm2_utils.startService(service);
						hdb_logger.trace(`Starting ${service}`);
					} else {
						const cf_err_msg = `${service} is not enabled in harperdb-config.yaml and cannot be restarted.`;
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

		// Check to see if the HDB restart script is running, if it is abort the restart.
		if ((await pm2_utils.isHdbRestartRunning()) === true) {
			hdb_logger.notify(RESTART_RUNNING_RESPONSE);
			console.error(RESTART_RUNNING_RESPONSE);
			return RESTART_RUNNING_RESPONSE;
		}

		console.log(RESTART_RESPONSE);

		if (clustering_enabled) {
			await restartAllClusteringServices();
		}

		const is_cf_reg = await pm2_utils.isServiceRegistered(hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS);
		// If custom functions is enabled in setting.js but is not registered to pm2, start service.
		if (custom_func_enabled && !is_cf_reg) {
			await pm2_utils.startService(hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS);
			hdb_logger.trace(`Starting ${hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS}`);
		}

		// The clustering processes are here because they are handled by the restartAllClusteringServices function above and dont need to be restarted again.
		let exclude_from_restart = [
			hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB,
			hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF,
			hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_INGEST_SERVICE,
			hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_REPLY_SERVICE,
		];

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
 * @returns {Promise<string>}
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

	const custom_func_enabled = config_utils.getConfigFromFile(hdb_terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_ENABLED);
	const service = hdb_terms.PROCESS_DESCRIPTORS_VALIDATE[service_req];

	// For clustered services a rolling restart is available.
	if (service === hdb_terms.PROCESS_DESCRIPTORS.HDB) {
		// Check to see if the HDB restart script is running, if it is abort the restart.
		if ((await pm2_utils.isHdbRestartRunning()) === true) {
			hdb_logger.notify(RESTART_RUNNING_RESPONSE);
			return RESTART_RUNNING_RESPONSE;
		}

		await pm2_utils.reloadStopStart(service);
	} else if (service === hdb_terms.PROCESS_DESCRIPTORS.PM2_LOGROTATE) {
		await pm2_utils.configureLogRotate();
	} else if (service.toLowerCase().includes('clustering')) {
		await restartClustering(service);
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
			const cf_err_msg = `${service} is not enabled in harperdb-config.yaml and cannot be restarted.`;
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
				const service_err_msg = `Stop service argument expected a string but received: ${cmd_args.service}`;
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

				if (service === 'clustering') {
					await pm2_utils.stopClustering();
				} else {
					await pm2_utils.stop(hdb_terms.PROCESS_DESCRIPTORS_VALIDATE[service]);
				}

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

async function restartAllClusteringServices() {
	await restartClustering(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB);
	await restartClustering(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
	await restartClustering(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_INGEST_SERVICE);
	await restartClustering(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_REPLY_SERVICE);

	await nats_utils.updateNodeNameLocalStreams();
	// Close the connection to the nats-server so that if stop/restart called from CLI process will exit.
	await nats_utils.closeConnection();
}

async function restartClustering(service) {
	service = hdb_terms.PROCESS_DESCRIPTORS_VALIDATE[service.toLowerCase()];
	const clustering_enabled = config_utils.getConfigFromFile(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED);
	const restarting_clustering = service === 'clustering';
	const reloading_clustering = service === 'clustering config';
	const is_currently_running = !restarting_clustering ? await pm2_utils.isServiceRegistered(service) : undefined;

	// If 'clustering' is passed to restart we are restarting all processes that make up clustering
	const clustering_running =
		restarting_clustering || reloading_clustering ? await pm2_utils.isClusteringRunning() : undefined;

	switch (true) {
		case reloading_clustering:
			if (!clustering_running) {
				hdb_logger.error(CLUSTERING_NOT_ENABLED_ERR);
				break;
			}

			await pm2_utils.reloadClustering();

			break;
		// If service is 'clustering' and clustering is running but not enabled, stop all the clustering processes.
		case restarting_clustering && clustering_running && !clustering_enabled:
			await pm2_utils.stopClustering();
			break;
		// If service is 'clustering' and clustering is not running but enabled, start all the clustering processes.
		case restarting_clustering && !clustering_running && clustering_enabled:
			await pm2_utils.startClustering();
			break;
		case restarting_clustering && clustering_running && clustering_enabled:
			await restartAllClusteringServices();
			break;
		// If service is 'clustering' and clustering is running and enabled, restart all the clustering processes.
		case restarting_clustering && !clustering_running && !clustering_enabled:
			hdb_logger.error(`${service} is not enabled in harperdb-config.yaml and cannot be restarted.`);
			break;
		// If the service is running but clustering has been disabled, stop the service.
		case is_currently_running && !clustering_enabled:
			await pm2_utils.stop(service);
			hdb_logger.trace(`Stopping ${service}`);
			break;
		// If the service is not running and clustering is enabled, start it.
		case !is_currently_running && clustering_enabled:
			if (
				service !== hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_INGEST_SERVICE &&
				service !== hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_REPLY_SERVICE
			) {
				await nats_config.generateNatsConfig(true, service);
			}

			await pm2_utils.startService(service);
			hdb_logger.trace(`Starting ${service}`);

			if (service === hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF) {
				// If clustering has not already been run there is a chance this wont exist.
				await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);
			}

			break;
		// If the service is not running and not clustering is not enable throw error.
		case !is_currently_running && !clustering_enabled:
			hdb_logger.error(`${service} is not enabled in harperdb-config.yaml and cannot be restarted.`);
			break;
		// If service is running and is enabled, restart it.
		case is_currently_running && clustering_enabled:
			if (
				service === hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_INGEST_SERVICE ||
				service === hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_REPLY_SERVICE
			) {
				await pm2_utils.reload(service);
			} else {
				await nats_config.generateNatsConfig(true, service);
				await pm2_utils.restart(service);
				// For security reasons we remove the server config after the server has connected
				await nats_config.removeNatsConfig(service);
			}

			break;
		default:
			hdb_logger.error(`Error restarting ${service}`);
	}
}
