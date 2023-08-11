'use strict';

const minimist = require('minimist');
const { isMainThread, parentPort } = require('worker_threads');
const hdb_terms = require('../utility/hdbTerms');
const { PROCESS_DESCRIPTORS_VALIDATE: SERVICES } = hdb_terms;
const hdb_logger = require('../utility/logging/harper_logger');
const hdb_utils = require('../utility/common_utils');
const nats_config = require('../server/nats/utility/natsConfig');
const nats_utils = require('../server/nats/utility/natsUtils');
const nats_terms = require('../server/nats/utility/natsTerms');
const config_utils = require('../config/configUtils');
const process_man = require('../utility/processManagement/processManagement');
const sys_info = require('../utility/environment/systemInformation');
const assignCMDENVVariables = require('../utility/assignCmdEnvVariables');
const { restartWorkers, onMessageByType } = require('../server/threads/manageThreads');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;
const env_mgr = require('../utility/environment/environmentManager');
env_mgr.initSync();

const RESTART_RESPONSE = `Restarting HarperDB. This may take up to ${hdb_terms.RESTART_TIMEOUT_MS / 1000} seconds.`;
const RESTART_NON_PM2_ERR =
	'Restart is not available from the CLI when running in non-pm2 mode. Either call restart from the API or stop and start HarperDB.';
const CLUSTERING_NOT_ENABLED_ERR = 'Clustering is not enabled so cannot be restarted';
const INVALID_SERVICE_ERR = 'Invalid service';

let pm2_mode;
let called_from_cli;

module.exports = {
	restart,
	restartService,
};

// Add ITC event listener to main thread which will be called from child that receives restart request.
if (isMainThread) {
	onMessageByType(hdb_terms.ITC_EVENT_TYPES.RESTART, (message) => {
		if (message.workerType) restartService({ service: message.workerType });
		else restart({ operation: 'restart' });
	});
}

/**
 * Restart HarperDB.
 * In PM2 mode HarperDB, Leaf and Hub servers are managed by PM2. Function will use PM2 to restart these three processes.
 * In good old regular mode (PM2 is nowhere to be seen) it will restart all the child threads and the hub and leaf server processes.
 * @param req
 * @returns {Promise<string>}
 */
async function restart(req) {
	called_from_cli = Object.keys(req).length === 0;
	pm2_mode = await process_man.isServiceRegistered(hdb_terms.HDB_PROC_DESCRIPTOR);
	const cli_args = minimist(process.argv);
	if (cli_args.service) {
		await restartService(cli_args);
		return;
	}

	if (called_from_cli && !pm2_mode) {
		console.error(RESTART_NON_PM2_ERR);
		return;
	}

	if (called_from_cli) console.log(RESTART_RESPONSE);

	// PM2 Mode is when PM2 was used to start the main HDB process and the two clustering servers.
	if (pm2_mode) {
		process_man.enterPM2Mode();
		hdb_logger.notify(RESTART_RESPONSE);
		// If restart is called with cmd/env vars we create a backup of config and update config file.
		const parsed_args = assignCMDENVVariables(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
		if (!hdb_utils.isEmptyOrZeroLength(Object.keys(parsed_args))) {
			config_utils.updateConfigValue(undefined, undefined, parsed_args, true, true);
		}

		// Await is purposely omitted here so that response is sent before restart process restarts itself (when called through API).
		restartPM2Mode();
		return RESTART_RESPONSE;
	}

	if (isMainThread) {
		hdb_logger.notify(RESTART_RESPONSE);
		await restartClustering();

		setTimeout(() => {
			restartWorkers();
		}, 50); // can't await this because it would deadlock on waiting for itself to finish
	} else {
		// Post msg to main parent thread requesting it restart all child threads.
		parentPort.postMessage({
			type: hdb_terms.ITC_EVENT_TYPES.RESTART,
		});
	}

	return RESTART_RESPONSE;
}

/**
 * Used to restart a particular service, services includes - clustering, clustering_config (calls native Nats reload) and http_workers
 * @param req
 * @returns {Promise<string>}
 */
async function restartService(req) {
	let { service } = req;
	if (hdb_terms.PROCESS_DESCRIPTORS_VALIDATE[service] === undefined) {
		throw handleHDBError(new Error(), INVALID_SERVICE_ERR, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	pm2_mode = await process_man.isServiceRegistered(hdb_terms.HDB_PROC_DESCRIPTOR);
	if (!isMainThread) {
		parentPort.postMessage({
			type: hdb_terms.ITC_EVENT_TYPES.RESTART,
			workerType: service,
		});
		if (service === 'custom_functions') service = 'Custom Functions';
		return `Restarting ${service}`;
	}

	let err_msg;
	switch (service) {
		case SERVICES.clustering:
			if (!env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
				err_msg = CLUSTERING_NOT_ENABLED_ERR;
				break;
			}
			if (called_from_cli) console.log(`Restarting clustering`);
			hdb_logger.notify('Restarting clustering');
			await restartClustering();
			break;

		case SERVICES.clustering_config:
		case SERVICES['clustering config']:
			if (!env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
				err_msg = CLUSTERING_NOT_ENABLED_ERR;
				break;
			}

			if (called_from_cli) console.log(`Restarting clustering_config`);
			hdb_logger.notify('Restarting clustering_config');
			await process_man.reloadClustering();
			break;

		case 'custom_functions':
		case 'custom functions':
		case SERVICES.harperdb:
		case SERVICES.http_workers:
			if (called_from_cli && !pm2_mode) {
				err_msg = `Restart ${service} is not available from the CLI when running in non-pm2 mode. Either call restart ${service} from the API or stop and start HarperDB.`;
				break;
			}

			if (called_from_cli) console.log(`Restarting http_workers`);
			hdb_logger.notify('Restarting http_workers');

			if (pm2_mode) {
				await process_man.restart(hdb_terms.HDB_PROC_DESCRIPTOR);
			} else {
				setTimeout(() => {
					restartWorkers('http');
				}, 200); // can't await this because it would deadlock on waiting for itself to finish
			}
			break;
		default:
			err_msg = `Unrecognized service: ${service}`;
			break;
	}

	if (err_msg) {
		hdb_logger.error(err_msg);
		if (called_from_cli) console.error(err_msg);
		return err_msg;
	}
	if (service === 'custom_functions') service = 'Custom Functions';
	return `Restarting ${service}`;
}

/**
 * Posts a dummy msg in the Nats work queue as a workaround for Nats bug.
 * There is a bug where on restart the most recent msg processed by the message
 * processor in the ingest service shows up again. Ref CORE-2018
 * @returns {Promise<void>}
 */
async function postDummyNatsMsg() {
	await nats_utils.publishToStream(
		`${nats_terms.SUBJECT_PREFIXES.TXN}.${nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name}`,
		nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
		nats_utils.addNatsMsgHeader({ operation: 'dummy_msg' }, undefined),
		{
			operation: 'dummy_msg',
		}
	);
}

/**
 * Will use PM2 module to restart processes its managing.
 * @returns {Promise<void>}
 */
async function restartPM2Mode() {
	await restartClustering();
	await process_man.restart(hdb_terms.HDB_PROC_DESCRIPTOR);
	// Restarting HarperDB will regenerate the nats config, for that reason we remove it below.
	// The timeout is there to wait for HDB to restart.
	await hdb_utils.async_set_timeout(2000);
	if (env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		await removeNatsConfig();
	}

	// Close the connection to the nats-server so that if stop/restart called from CLI process will exit.
	if (called_from_cli) {
		await nats_utils.closeConnection();
		process.exit(0);
	}
}

/**
 * Restarts the Hub & Leaf clustering servers. Will also restart ingest and reply threads
 * if restart request is coming through API.
 * @returns {Promise<void>}
 */
async function restartClustering() {
	if (!config_utils.getConfigFromFile(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) return;

	// Check to see if clustering is running, if it's not we start it
	const running_ps = await sys_info.getHDBProcessInfo();
	if (running_ps.clustering.length === 0) {
		hdb_logger.trace('Clustering not running, restart will start clustering services');
		await nats_config.generateNatsConfig(true);
		await process_man.startClusteringProcesses();
		await process_man.startClusteringThreads();
		await removeNatsConfig();

		// Close the connection to the nats-server so that if stop/restart called from CLI process will exit.
		if (called_from_cli) await nats_utils.closeConnection();
	} else {
		//await postDummyNatsMsg();
		await nats_config.generateNatsConfig(true);

		if (pm2_mode) {
			hdb_logger.trace('Restart clustering restarting PM2 managed Hub and Leaf servers');
			await process_man.restart(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB);
			await process_man.restart(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
		} else {
			const proc = await sys_info.getHDBProcessInfo();
			proc.clustering.forEach((p) => {
				hdb_logger.trace('Restart clustering killing process pid', p.pid);
				process.kill(p.pid);
			});
		}
		// Give the clustering servers time to restart before moving on.
		await hdb_utils.async_set_timeout(3000);
		await removeNatsConfig();

		// Check to see if the node name or purge config has been updated,
		// if it has we need to change config on any local streams.
		//await nats_utils.updateLocalStreams();

		// Close the connection to the nats-server so that if stop/restart called from CLI process will exit.
		if (called_from_cli) await nats_utils.closeConnection();

		hdb_logger.trace('Restart clustering restarting ingest and reply service threads');
		let ingestRestart = restartWorkers(hdb_terms.LAUNCH_SERVICE_SCRIPTS.NATS_INGEST_SERVICE);
		let replyRestart = restartWorkers(hdb_terms.LAUNCH_SERVICE_SCRIPTS.NATS_REPLY_SERVICE);
		await ingestRestart;
		await replyRestart;
	}
}

async function removeNatsConfig() {
	await nats_config.removeNatsConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB);
	await nats_config.removeNatsConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
}
