'use strict';

const minimist = require('minimist');
const { isMainThread, parentPort } = require('worker_threads');
const hdbTerms = require('../utility/hdbTerms.ts');
const hdbLogger = require('../utility/logging/harper_logger.js');
const processMan = require('../utility/processManagement/processManagement.js');
const { compactOnStart } = require('./copyDb.ts');
const { restartWorkers, onMessageByType, shutdownWorkersNow } = require('../server/threads/manageThreads.js');
const { handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;
const envMgr = require('../utility/environment/environmentManager.js');
const { server } = require('../server/Server.ts');
const path = require('node:path');
const { unlinkSync } = require('node:fs');
envMgr.initSync();

const RESTART_RESPONSE = `Restarting HarperDB. This may take up to ${hdbTerms.RESTART_TIMEOUT_MS / 1000} seconds.`;
const INVALID_SERVICE_ERR = 'Invalid service';

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
		const hdbPid = processMan.getHdbPid();
		console.error(hdbPid ? 'Restarting Harper...' : 'Starting Harper...');
		require('./run.js').launch(true);
		return RESTART_RESPONSE;
	}

	if (isMainThread) {
		hdbLogger.notify(RESTART_RESPONSE);

		if (envMgr.get(hdbTerms.CONFIG_PARAMS.STORAGE_COMPACTONSTART)) await compactOnStart();

		if (process.env.HARPER_EXIT_ON_RESTART) {
			// use this to exit the process so that it will be restarted by the
			// PM/container/orchestrator.
			hdbLogger.warn('Exiting Harper process to trigger a container restart');
			process.exit(0);
		}
		setTimeout(async () => {
			// It seems like you should just be able to start the other process and kill this process and everything should
			// be cleaned up, however that doesn't work for some reason; the socket listening fds somehow get transferred to the
			// child process if they are not explicitly closed. And when transferred they are orphaned listening, accepting
			// connections and hanging. So we need to explicitly close down all the workers and then start the new process
			// and shut down.
			hdbLogger.debug('Shutdown workers');
			await shutdownWorkersNow();
			await processMan.cleanupChildrenProcesses(false);
			// remove pid file so it doesn't trip up the launch
			await unlinkSync(path.join(envMgr.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), hdbTerms.HDB_PID_FILE), `${process.pid}`);
			hdbLogger.debug('Starting new process...');
			// now launch the new process and exit this process
			require('./run.js').launch(true);
		}, 50); // can't await this because it is going to do an exit()
	} else {
		// Post msg to main parent thread requesting it restart (so the main thread can process.exit())
		parentPort.postMessage({
			type: hdbTerms.ITC_EVENT_TYPES.RESTART,
		});
	}

	return RESTART_RESPONSE;
}

/**
 * Used to restart a particular service, services includes - httpWorkers
 * @param req
 * @returns {Promise<string>}
 */
async function restartService(req) {
	let { service } = req;
	if (hdbTerms.HDB_PROCESS_SERVICES[service] === undefined) {
		throw handleHDBError(new Error(), INVALID_SERVICE_ERR, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}
	processMan.expectedRestartOfChildren();
	if (!isMainThread) {
		if (req.replicated) {
			server.replication.monitorNodeCAs(); // get all the CAs from the nodes we know about
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
				if (node.name === server.replication.getThisNodeName()) continue;
				// for now, only one at a time
				let job_id;
				try {
					({ job_id } = await server.replication.sendOperationToNode(node, req));
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
							let response = await server.replication.sendOperationToNode(node, {
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
		case 'custom_functions':
		case 'custom functions':
		case hdbTerms.HDB_PROCESS_SERVICES.harperdb:
		case hdbTerms.HDB_PROCESS_SERVICES.http_workers:
		case hdbTerms.HDB_PROCESS_SERVICES.http:
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
