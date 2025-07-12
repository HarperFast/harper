'use strict';

const minimist = require('minimist');
const { isMainThread, parentPort, threadId } = require('worker_threads');
const hdbTerms = require('../utility/hdbTerms.ts');
const hdbLogger = require('../utility/logging/harper_logger.js');
const hdbUtils = require('../utility/common_utils.js');
const natsConfig = require('../server/nats/utility/natsConfig.js');
const natsUtils = require('../server/nats/utility/natsUtils.js');
const natsTerms = require('../server/nats/utility/natsTerms.js');
const configUtils = require('../config/configUtils.js');
const processMan = require('../utility/processManagement/processManagement.js');
const sysInfo = require('../utility/environment/systemInformation.js');
const { compactOnStart } = require('./copyDb.ts');
const assignCMDENVVariables = require('../utility/assignCmdEnvVariables.js');
const { restartWorkers, onMessageByType } = require('../server/threads/manageThreads.js');
const { handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;
const envMgr = require('../utility/environment/environmentManager.js');
const { sendOperationToNode, getThisNodeName, monitorNodeCAs } = require('../server/replication/replicator.ts');
const { getHDBNodeTable } = require('../server/replication/knownNodes.ts');
envMgr.initSync();

const RESTART_RESPONSE = `Restarting HarperDB. This may take up to ${hdbTerms.RESTART_TIMEOUT_MS / 1000} seconds.`;
const RESTART_NON_PM2_ERR =
	'Restart is not available from the CLI when running in non-pm2 mode. Either call restart from the API or stop and start HarperDB.';
const CLUSTERING_NOT_ENABLED_ERR = 'Clustering is not enabled so cannot be restarted';
const INVALID_SERVICE_ERR = 'Invalid service';

let pm2Mode;
let calledFromCli;

module.exports = {
	restart,
	restartService,
};

// Add ITC event listener to main thread which will be called from child that receives restart request.
if (isMainThread) {
	onMessageByType(hdbTerms.ITC_EVENT_TYPES.RESTART, async (message, port) => {
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
	calledFromCli = Object.keys(req).length === 0;

	const cliArgs = minimist(process.argv);
	if (cliArgs.service) {
		await restartService(cliArgs);
		return;
	}

	if (calledFromCli) {
		const isHarperRunning = processMan.isHdbRunning();
		if (!isHarperRunning) console.error('Harper must be running to restart it');
		else {
			console.error('Restarting Harper...');
			require('./run.js').launch(true);
		}
		return RESTART_RESPONSE;
	}

	if (isMainThread) {
		hdbLogger.notify(RESTART_RESPONSE);

		if (envMgr.get(hdbTerms.CONFIG_PARAMS.STORAGE_COMPACTONSTART)) await compactOnStart();

		if (process.env.HARPER_EXIT_ON_RESTART) {
			// use this to exit the process so that it will be restarted by the
			// PM/container/orchestrator.
			process.exit(0);
		}

		setTimeout(() => {
			require('./run.js').launch(true);
		}, 50); // can't await this because it is going to do an exit()
	} else {
		// Post msg to main parent thread requesting it restart (on the main thread can process.exit())
		parentPort.postMessage({
			type: hdbTerms.ITC_EVENT_TYPES.RESTART,
		});
	}

	return RESTART_RESPONSE;
}

/**
 * Used to restart a particular service, services includes - clustering, clusteringConfig (calls native Nats reload) and httpWorkers
 * @param req
 * @returns {Promise<string>}
 */
async function restartService(req) {
	let { service } = req;
	if (hdbTerms.HDB_PROCESS_SERVICES[service] === undefined) {
		throw handleHDBError(new Error(), INVALID_SERVICE_ERR, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}
	processMan.expectedRestartOfChildren();
	pm2Mode = await processMan.isServiceRegistered(hdbTerms.PROCESS_DESCRIPTORS.HDB);
	if (!isMainThread) {
		if (req.replicated) {
			monitorNodeCAs(); // get all the CAs from the nodes we know about
		}
		parentPort.postMessage({
			type: hdbTerms.ITC_EVENT_TYPES.RESTART,
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
		let replicatedResponses;
		if (req.replicated) {
			req.replicated = false; // don't send a replicated flag to the nodes we are sending to
			replicatedResponses = [];
			for (let node of server.nodes) {
				if (node.name === getThisNodeName()) continue;
				// for now, only one at a time
				let job_id;
				try {
					({ job_id } = await sendOperationToNode(node, req));
				} catch (err) {
					// If request to node fails, add the error to the response and continue to the next node
					replicatedResponses.push({ node: node.name, message: err.message });
					continue;
				}
				// wait for the job to finish by polling for the completion of the job
				replicatedResponses.push(
					await new Promise((resolve, reject) => {
						const RETRY_INTERVAL = 250;
						let retriesLeft = 2400; // 10 minutes
						let interval = setInterval(async () => {
							if (retriesLeft-- <= 0) {
								clearInterval(interval);
								let error = new Error('Timed out waiting for restart job to complete');
								error.replicated = replicatedResponses; // report the finished restarts
								reject(error);
							}
							let response = await sendOperationToNode(node, {
								operation: 'get_job',
								id: job_id,
							});
							const jobResult = response.results[0];
							if (jobResult.status === 'COMPLETE') {
								clearInterval(interval);
								resolve({ node: node.name, message: jobResult.message });
							}
							if (jobResult.status === 'ERROR') {
								clearInterval(interval);
								let error = new Error(jobResult.message);
								error.replicated = replicatedResponses; // report the finished restarts
								reject(error);
							}
						}, RETRY_INTERVAL);
					})
				);
			}
			return { replicated: replicatedResponses };
		}
		return;
	}

	let errMsg;
	switch (service) {
		case hdbTerms.HDB_PROCESS_SERVICES.clustering:
			if (!envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
				errMsg = CLUSTERING_NOT_ENABLED_ERR;
				break;
			}
			if (calledFromCli) console.log(`Restarting clustering`);
			hdbLogger.notify('Restarting clustering');
			await restartClustering();
			break;

		case hdbTerms.HDB_PROCESS_SERVICES.clustering_config:
		case hdbTerms.HDB_PROCESS_SERVICES['clustering config']:
			if (!envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
				errMsg = CLUSTERING_NOT_ENABLED_ERR;
				break;
			}

			if (calledFromCli) console.log(`Restarting clusteringConfig`);
			hdbLogger.notify('Restarting clustering_config');
			await processMan.reloadClustering();
			break;

		case 'custom_functions':
		case 'custom functions':
		case hdbTerms.HDB_PROCESS_SERVICES.harperdb:
		case hdbTerms.HDB_PROCESS_SERVICES.http_workers:
		case hdbTerms.HDB_PROCESS_SERVICES.http:
			if (calledFromCli && !pm2Mode) {
				errMsg = `Restart ${service} is not available from the CLI when running in non-pm2 mode. Either call restart ${service} from the API or stop and start HarperDB.`;
				break;
			}

			if (calledFromCli) console.log(`Restarting httpWorkers`);
			hdbLogger.notify('Restarting http_workers');

			if (calledFromCli) {
				await processMan.restart(hdbTerms.PROCESS_DESCRIPTORS.HDB);
			} else {
				await restartWorkers('http');
			}
			break;
		default:
			errMsg = `Unrecognized service: ${service}`;
			break;
	}

	if (errMsg) {
		hdbLogger.error(errMsg);
		if (calledFromCli) console.error(errMsg);
		return errMsg;
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
	await processMan.restart(hdbTerms.PROCESS_DESCRIPTORS.HDB);
	// Restarting HarperDB will regenerate the nats config, for that reason we remove it below.
	// The timeout is there to wait for HDB to restart.
	await hdbUtils.asyncSetTimeout(2000);
	if (envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		await removeNatsConfig();
	}

	// Close the connection to the nats-server so that if stop/restart called from CLI process will exit.
	if (calledFromCli) {
		await natsUtils.closeConnection();
		process.exit(0);
	}
}

/**
 * Restarts the Hub & Leaf clustering servers. Will also restart ingest and reply threads
 * if restart request is coming through API.
 * @returns {Promise<void>}
 */
async function restartClustering() {
	if (!configUtils.getConfigFromFile(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) return;

	// Check to see if clustering is running, if it's not we start it
	const runningPs = await sysInfo.getHDBProcessInfo();
	if (runningPs.clustering.length === 0) {
		hdbLogger.trace('Clustering not running, restart will start clustering services');
		await natsConfig.generateNatsConfig(true);
		await processMan.startClusteringProcesses();
		await processMan.startClusteringThreads();
		await removeNatsConfig();

		// Close the connection to the nats-server so that if stop/restart called from CLI process will exit.
		if (calledFromCli) await natsUtils.closeConnection();
	} else {
		await natsConfig.generateNatsConfig(true);

		if (pm2Mode) {
			hdbLogger.trace('Restart clustering restarting PM2 managed Hub and Leaf servers');
			await processMan.restart(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_HUB);
			await processMan.restart(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
		} else {
			const proc = await sysInfo.getHDBProcessInfo();
			proc.clustering.forEach((p) => {
				hdbLogger.trace('Restart clustering killing process pid', p.pid);
				process.kill(p.pid);
			});
		}
		// Give the clustering servers time to restart before moving on.
		await hdbUtils.asyncSetTimeout(3000);
		await removeNatsConfig();

		// Check to see if the node name or purge config has been updated,
		// if it has we need to change config on any local streams.
		await natsUtils.updateLocalStreams();

		// Close the connection to the nats-server so that if stop/restart called from CLI process will exit.
		if (calledFromCli) await natsUtils.closeConnection();

		hdbLogger.trace('Restart clustering restarting ingest and reply service threads');
		let ingestRestart = restartWorkers(hdbTerms.LAUNCH_SERVICE_SCRIPTS.NATS_INGEST_SERVICE);
		let replyRestart = restartWorkers(hdbTerms.LAUNCH_SERVICE_SCRIPTS.NATS_REPLY_SERVICE);
		await ingestRestart;
		await replyRestart;
	}
}

async function removeNatsConfig() {
	await natsConfig.removeNatsConfig(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_HUB);
	await natsConfig.removeNatsConfig(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
}
