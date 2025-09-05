'use strict';

const hdbTerms = require('../hdbTerms.ts');
const hdbUtils = require('../common_utils.js');
const natsConfig = require('../../server/nats/utility/natsConfig.js');
const natsUtils = require('../../server/nats/utility/natsUtils.js');
const natsTerms = require('../../server/nats/utility/natsTerms.js');
const servicesConfig = require('./servicesConfig.js');
const envMangr = require('../environment/environmentManager.js');
const hdbLogger = require('../../utility/logging/harper_logger.js');
const clusteringUtils = require('../clustering/clusterUtilities.js');
const { startWorker, onMessageFromWorkers } = require('../../server/threads/manageThreads.js');
const sysInfo = require('../environment/systemInformation.js');
const util = require('util');
const fs = require('fs');
const path = require('path');
const terms = require('../hdbTerms');
const { setTimeout: delay } = require('node:timers/promises');
const { execFile, fork } = require('child_process');

module.exports = {
	start,
	restart,
	kill,
	startAllServices,
	startService,
	restartHdb,
	startClusteringProcesses,
	startClusteringThreads,
	isHdbRestartRunning,
	isHdbRunning,
	killChildrenProcesses,
	reloadClustering,
	expectedRestartOfChildren,
};

onMessageFromWorkers((message) => {
	if (message.type === 'restart') envMangr.initSync(true);
});

let childProcesses;
const MAX_RESTARTS = 10;
let shuttingDown;
/**
 * Starts a service
 * @param procConfig
 * @returns void
 */
function start(procConfig, noKill = false) {
	const args = typeof procConfig.args === 'string' ? procConfig.args.split(' ') : procConfig.args;
	procConfig.silent = true;
	procConfig.detached = true;
	let subprocess = procConfig.script
		? fork(procConfig.script, args, procConfig)
		: execFile(procConfig.binFile, args, procConfig);
	subprocess.name = procConfig.name;
	subprocess.config = procConfig;
	subprocess.on('error', async (code, message) => {
		console.error(code, message);
	});
	subprocess.on('exit', async (code) => {
		let index = childProcesses.indexOf(subprocess); // dead, remove it from processes to kill now
		if (index > -1) childProcesses.splice(index, 1);
		if (!shuttingDown && code !== 0) {
			procConfig.restarts = (procConfig.restarts || 0) + 1;
			// restart the child process
			if (procConfig.restarts < MAX_RESTARTS) {
				if (!fs.existsSync(natsConfig.getHubConfigPath())) {
					await natsConfig.generateNatsConfig(true);
					start(procConfig);
					await new Promise((resolve) => setTimeout(resolve, 3000));
					await natsConfig.removeNatsConfig(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_HUB);
					await natsConfig.removeNatsConfig(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
				} else start(procConfig);
			}
		}
	});
	const SERVICE_DEFINITION = {
		serviceName: procConfig.name.replace(/ /g, '-'),
	};
	function extractMessages(log) {
		const CLUSTERING_LOG_LEVEL = envMangr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LOGLEVEL);
		let NATS_PARSER = /\[\d+][^\[]+\[(\w+)]/g;
		let logStart,
			lastPosition = 0,
			lastLevel;
		while ((logStart = NATS_PARSER.exec(log))) {
			// Only log if level is at or above clustering log level
			if (
				logStart.index &&
				natsTerms.LOG_LEVEL_HIERARCHY[CLUSTERING_LOG_LEVEL] >= natsTerms.LOG_LEVEL_HIERARCHY[lastLevel || 'info']
			) {
				const output =
					lastLevel === natsTerms.LOG_LEVELS.ERR || lastLevel === natsTerms.LOG_LEVELS.WRN
						? hdbLogger.OUTPUTS.STDERR
						: hdbLogger.OUTPUTS.STDOUT;

				hdbLogger.logCustomLevel(
					lastLevel || 'info',
					output,
					SERVICE_DEFINITION,
					log.slice(lastPosition, logStart.index).trim()
				);
			}

			let [startText, level] = logStart;
			lastPosition = logStart.index + startText.length;
			lastLevel = natsTerms.LOG_LEVELS[level];
		}

		// Only log if level is at or above clustering log level
		if (natsTerms.LOG_LEVEL_HIERARCHY[CLUSTERING_LOG_LEVEL] >= natsTerms.LOG_LEVEL_HIERARCHY[lastLevel || 'info']) {
			const output =
				lastLevel === natsTerms.LOG_LEVELS.ERR || lastLevel === natsTerms.LOG_LEVELS.WRN
					? hdbLogger.OUTPUTS.STDERR
					: hdbLogger.OUTPUTS.STDOUT;

			hdbLogger.logCustomLevel(
				lastLevel || 'info',
				output,
				SERVICE_DEFINITION,
				log.toString().slice(lastPosition).trim()
			);
		}
	}
	subprocess.stdout.on('data', extractMessages);
	subprocess.stderr.on('data', extractMessages);
	subprocess.unref();

	// if we are running in standard mode, then we want to clean up our child processes when we exit
	if (!childProcesses) {
		childProcesses = [];
		if (!noKill) {
			process.on('exit', killChildrenProcesses);
			process.on('SIGINT', killChildrenProcesses);
			process.on('SIGQUIT', killChildrenProcesses);
			process.on('SIGTERM', killChildrenProcesses);
		}
	}
	childProcesses.push(subprocess);
}
function killChildrenProcesses(exit = true) {
	shuttingDown = true;
	if (!childProcesses || childProcesses.length === 0) return;
	hdbLogger.error('killing children');
	childProcesses.map((proc) => proc.kill());
	if (exit) process.exit(0);
	else return delay(2000); // give these processes some time to exit
}

/**
 * restart processes
 * @param serviceName
 * @returns {Promise<unknown>}
 */
function restart(serviceName) {
	expectedRestartOfChildren();
	for (let childProcess of childProcesses || []) {
		// kill the child process and let it (auto) restart
		if (childProcess.name === serviceName) {
			childProcess.kill();
		}
	}
}

/**
 * Reset the restart counts for all child processes because we are doing an intentional restart
 */
function expectedRestartOfChildren() {
	for (let childProcess of childProcesses || []) {
		if (childProcess.config) childProcess.config.restarts = 0; // reset the restart count
	}
}
/**
 * To restart HarperDB we use processManagement to fork a process and then call restart from that process.
 * We do this because we were seeing random errors when HDB was calling restart on itself.
 * @returns {Promise<void>}
 */
async function restartHdb() {
	await start(servicesConfig.generateRestart());
}

/**
 * Checks to see if the HDB restart script is currently running.
 * @returns {Promise<boolean>}
 */
async function isHdbRestartRunning() {
	const allProcesses = await list();
	for (const p in allProcesses) {
		const proc = allProcesses[p];
		if (proc.name === hdbTerms.PROCESS_DESCRIPTORS.RESTART_HDB) {
			return true;
		}
	}

	return false;
}
/**
 * Checks to see if Harper is currently running.
 * @returns {Promise<boolean>}
 */
function isHdbRunning() {
	const harperPath = envMangr.getHdbBasePath();
	return harperPath && fs.existsSync(path.join(harperPath, terms.HDB_PID_FILE));
}
function kill() {
	for (let process of childProcesses || []) {
		process.kill();
	}
	childProcesses = [];
	return;
}

/**
 * starts all services based on the servicesConfig
 * @returns {Promise<void>}
 */
async function startAllServices() {
	// The clustering services are started separately because their config is
	// removed for security reasons after they are connected.
	// Also we create the work queue stream when we start clustering
	await startClusteringProcesses();
	await startClusteringThreads();

	await start(servicesConfig.generateAllServiceConfigs());
}

/**
 * start a specific service
 * @param serviceName
 * @returns {Promise<void>}
 */
async function startService(serviceName, noKill = false) {
	let startConfig;
	serviceName = serviceName.toLowerCase();
	switch (serviceName) {
		case hdbTerms.PROCESS_DESCRIPTORS.HDB.toLowerCase():
			startConfig = servicesConfig.generateMainServerConfig();
			break;
		case hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_INGEST_SERVICE.toLowerCase():
			startConfig = servicesConfig.generateNatsIngestServiceConfig();
			break;
		case hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_REPLY_SERVICE.toLowerCase():
			startConfig = servicesConfig.generateNatsReplyServiceConfig();
			break;
		case hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_HUB.toLowerCase():
			startConfig = servicesConfig.generateNatsHubServerConfig();
			await start(startConfig, noKill);
			// For security reasons remove the Nats servers config file from disk after service has started.
			await natsConfig.removeNatsConfig(serviceName);
			return;
		case hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF.toLowerCase():
			startConfig = servicesConfig.generateNatsLeafServerConfig();
			await start(startConfig, noKill);
			// For security reasons remove the Nats servers config file from disk after service has started.
			await natsConfig.removeNatsConfig(serviceName);
			return;
		case hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_UPGRADE_4_0_0.toLowerCase():
			startConfig = servicesConfig.generateClusteringUpgradeV4ServiceConfig();
			break;
		default:
			throw new Error(`Start service called with unknown service config: ${serviceName}`);
	}
	start(startConfig, noKill);
}

/**
 * Will check the env setting vars to see if there has been a change in number or services running.
 * If no change reload is called. If values have changed, service is stopped and started.
 * @param serviceName
 * @returns {Promise<void>}
 */
async function reloadStopStart(serviceName) {
	// Check to see if there has been an update to the max process setting value. If there has been we need to stop the service and start it again.
	const settingProcessCount =
		envMangr.get(hdbTerms.CONFIG_PARAMS.THREADS_COUNT) ?? envMangr.get(hdbTerms.CONFIG_PARAMS.THREADS);
	const currentProcess = await describe(serviceName);
	const currentProcessCount = hdbUtils.isEmptyOrZeroLength(currentProcess) ? 0 : currentProcess.length;
	if (settingProcessCount !== currentProcessCount) {
		await stop(serviceName);
		await startService(serviceName);
	} else if (serviceName === hdbTerms.PROCESS_DESCRIPTORS.HDB) {
		// To restart HDB we need to fork a temp process which calls restart.
		await restartHdb();
	} else {
		// If no change to the max process values just call reload.
		await reload(serviceName);
	}
}

let ingestWorker;
let replyWorker;
/**
 * Starts all the processes that make up clustering
 * @returns {Promise<void>}
 */
async function startClusteringProcesses(noKill = false) {
	for (const proc in hdbTerms.CLUSTERING_PROCESSES) {
		const service = hdbTerms.CLUSTERING_PROCESSES[proc];
		await startService(service, noKill);
	}
}
/**
 * Starts all the threads that make up clustering
 * @returns {Promise<void>}
 */
async function startClusteringThreads() {
	replyWorker = startWorker(hdbTerms.LAUNCH_SERVICE_SCRIPTS.NATS_REPLY_SERVICE, {
		name: hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_REPLY_SERVICE,
	});

	// There was an update to our nats logic where we stopped using the work queue stream.
	// This code is here to delete it if it still exists.
	try {
		await natsUtils.deleteLocalStream('__HARPERDB_WORK_QUEUE__');
	} catch (err) {}

	// Check to see if the node name or purge config has been updated,
	// if it has we need to change config on any local streams.
	await natsUtils.updateLocalStreams();

	// If any node records are marked as pre 4.0.0 version start process to re-establish node connections.
	const nodes = await clusteringUtils.getAllNodeRecords();
	for (let i = 0, recLength = nodes.length; i < recLength; i++) {
		if (nodes[i].system_info?.hdb_version === hdbTerms.PRE_4_0_0_VERSION) {
			hdbLogger.info('Starting clustering upgrade 4.0.0 process');
			startWorker(hdbTerms.LAUNCH_SERVICE_SCRIPTS.NODES_UPGRADE_4_0_0, { name: 'Upgrade-4-0-0' });
			break;
		}
	}
}

/**
 * Stop all the services that make up clustering
 */
async function stopClustering() {
	for (const proc in hdbTerms.CLUSTERING_PROCESSES) {
		if (proc === hdbTerms.CLUSTERING_PROCESSES.CLUSTERING_INGEST_PROC_DESCRIPTOR) {
			// TODO: send a broadcast so worker threads that are doing subscribers can stop their subscription
		} else if (proc === hdbTerms.CLUSTERING_PROCESSES.CLUSTERING_REPLY_SERVICE_DESCRIPTOR) {
			await replyWorker.terminate();
		} else {
			const service = hdbTerms.CLUSTERING_PROCESSES[proc];
			await stop(service);
		}
	}
}

/**
 * Calls a native Nats method to reload the Hub & Leaf servers.
 * This will NOT restart the processManagement process.
 * @returns {Promise<void>}
 */
async function reloadClustering() {
	await natsConfig.generateNatsConfig(true);
	await natsUtils.reloadNATSHub();
	await natsUtils.reloadNATSLeaf();

	// For security reasons remove the Hub & Leaf config after they have been reloaded
	await natsConfig.removeNatsConfig(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_HUB.toLowerCase());
	await natsConfig.removeNatsConfig(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF.toLowerCase());
}
