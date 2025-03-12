'use strict';

const minimist = require('minimist');
const { isMainThread, parentPort, threadId } = require('worker_threads');
const hdb_terms = require('../utility/hdbTerms');
const hdb_logger = require('../utility/logging/harper_logger');
const hdb_utils = require('../utility/common_utils');
const nats_config = require('../server/nats/utility/natsConfig');
const nats_utils = require('../server/nats/utility/natsUtils');
const nats_terms = require('../server/nats/utility/natsTerms');
const config_utils = require('../config/configUtils');
const process_man = require('../utility/processManagement/processManagement');
const sys_info = require('../utility/environment/systemInformation');
const { compactOnStart } = require('./copyDb');
const assignCMDENVVariables = require('../utility/assignCmdEnvVariables');
const { restartWorkers, onMessageByType } = require('../server/threads/manageThreads');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;
const env_mgr = require('../utility/environment/environmentManager');
const { sendOperationToNode, getThisNodeName, monitorNodeCAs } = require('../server/replication/replicator');
const { getHDBNodeTable } = require('../server/replication/knownNodes');
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
	onMessageByType(hdb_terms.ITC_EVENT_TYPES.RESTART, async (message, port) => {
		if (message.workerType) await restartService({ service: message.workerType });
		else restart({ operation: 'restart' });
		port.postMessage({ type: 'restart-complete' });
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
	pm2_mode = await process_man.isServiceRegistered(hdb_terms.PROCESS_DESCRIPTORS.HDB);
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

		if (env_mgr.get(hdb_terms.CONFIG_PARAMS.STORAGE_COMPACTONSTART)) await compactOnStart();

		if (process.env.HARPER_EXIT_ON_RESTART) {
			// use this to exit the process so that it will be restarted by the
			// PM/container/orchestrator.
			process.exit(0);
		}

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
	if (hdb_terms.HDB_PROCESS_SERVICES[service] === undefined) {
		throw handleHDBError(new Error(), INVALID_SERVICE_ERR, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}
	process_man.expectedRestartOfChildren();
	pm2_mode = await process_man.isServiceRegistered(hdb_terms.PROCESS_DESCRIPTORS.HDB);
	if (!isMainThread) {
		if (req.replicated) {
			monitorNodeCAs(); // get all the CAs from the nodes we know about
		}
		parentPort.postMessage({
			type: hdb_terms.ITC_EVENT_TYPES.RESTART,
			workerType: service,
		});
		parentPort.ref(); // don't let the parent thread exit until we're done
		await new Promise((resolve) => {
			parentPort.on('message', (msg) => {
				if (msg.type === 'restart-complete') {
					resolve();
					parentPort.unref();
				}
			});
		});
		let replicated_responses;
		if (req.replicated) {
			req.replicated = false; // don't send a replicated flag to the nodes we are sending to
			replicated_responses = [];
			for (let node of server.nodes) {
				if (node.name === getThisNodeName()) continue;
				// for now, only one at a time
				let { job_id } = await sendOperationToNode(node, req);
				// wait for the job to finish by polling for the completion of the job
				replicated_responses.push(
					await new Promise((resolve, reject) => {
						const RETRY_INTERVAL = 250;
						let retries_left = 2400; // 10 minutes
						let interval = setInterval(async () => {
							if (retries_left-- <= 0) {
								clearInterval(interval);
								let error = new Error('Timed out waiting for restart job to complete');
								error.replicated = replicated_responses; // report the finished restarts
								reject(error);
							}
							let response = await sendOperationToNode(node, {
								operation: 'get_job',
								id: job_id,
							});
							const job_result = response.results[0];
							if (job_result.status === 'COMPLETE') {
								clearInterval(interval);
								resolve({ node: node.name, message: job_result.message });
							}
							if (job_result.status === 'ERROR') {
								clearInterval(interval);
								let error = new Error(job_result.message);
								error.replicated = replicated_responses; // report the finished restarts
								reject(error);
							}
						}, RETRY_INTERVAL);
					})
				);
			}
			return { replicated: replicated_responses };
		}
		return;
	}

	let err_msg;
	switch (service) {
		case hdb_terms.HDB_PROCESS_SERVICES.clustering:
			if (!env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
				err_msg = CLUSTERING_NOT_ENABLED_ERR;
				break;
			}
			if (called_from_cli) console.log(`Restarting clustering`);
			hdb_logger.notify('Restarting clustering');
			await restartClustering();
			break;

		case hdb_terms.HDB_PROCESS_SERVICES.clustering_config:
		case hdb_terms.HDB_PROCESS_SERVICES['clustering config']:
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
		case hdb_terms.HDB_PROCESS_SERVICES.harperdb:
		case hdb_terms.HDB_PROCESS_SERVICES.http_workers:
		case hdb_terms.HDB_PROCESS_SERVICES.http:
			if (called_from_cli && !pm2_mode) {
				err_msg = `Restart ${service} is not available from the CLI when running in non-pm2 mode. Either call restart ${service} from the API or stop and start HarperDB.`;
				break;
			}

			if (called_from_cli) console.log(`Restarting http_workers`);
			hdb_logger.notify('Restarting http_workers');

			if (called_from_cli) {
				await process_man.restart(hdb_terms.PROCESS_DESCRIPTORS.HDB);
			} else {
				await restartWorkers('http');
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
 * Will use PM2 module to restart processes its managing.
 * @returns {Promise<void>}
 */
async function restartPM2Mode() {
	await restartClustering();
	await process_man.restart(hdb_terms.PROCESS_DESCRIPTORS.HDB);
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
		await nats_utils.updateLocalStreams();

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
