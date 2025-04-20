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
const childProcess = require('child_process');
const fs = require('fs');
const { execFile } = childProcess;

let pm2;

module.exports = {
	enterPM2Mode,
	start,
	stop,
	reload,
	restart,
	list,
	describe,
	connect,
	kill,
	startAllServices,
	startService,
	getUniqueServicesList,
	restartAllServices,
	isServiceRegistered,
	reloadStopStart,
	restartHdb,
	deleteProcess,
	startClusteringProcesses,
	startClusteringThreads,
	isHdbRestartRunning,
	isClusteringRunning,
	stopClustering,
	reloadClustering,
	expectedRestartOfChildren,
};

// This indicates when we are running as a CLI scripting command (kind of taking the place of processManagement's CLI), and so we
// are generally starting and stopping processes through PM2.
let pm2Mode = false;

onMessageFromWorkers((message) => {
	if (message.type === 'restart') envMangr.initSync(true);
});

/**
 * Enable scripting mode where we act as the PM2 CLI to start and stop other processes and then exit
 */
function enterPM2Mode() {
	pm2Mode = true;
}
/**
 * Either connects to a running processManagement daemon or launches one.
 * @returns {Promise<unknown>}
 */
function connect() {
	if (!pm2) pm2 = require('pm2');
	return new Promise((resolve, reject) => {
		pm2.connect((err, res) => {
			if (err) {
				reject(err);
			}

			resolve(res);
		});
	});
}

let childProcesses;
const MAX_RESTARTS = 10;
let shuttingDown;
/**
 * Starts a service
 * @param procConfig
 * @returns {Promise<unknown>}
 */
function start(procConfig, noKill = false) {
	if (pm2Mode) return startWithPM2(procConfig);
	let subprocess = execFile(procConfig.script, procConfig.args.split(' '), procConfig);
	subprocess.name = procConfig.name;
	subprocess.config = procConfig;
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

			hdbLogger.logCustomLevel(lastLevel || 'info', output, SERVICE_DEFINITION, log.slice(lastPosition).trim());
		}
	}
	subprocess.stdout.on('data', extractMessages);
	subprocess.stderr.on('data', extractMessages);
	subprocess.unref();

	// if we are running in standard mode, then we want to clean up our child processes when we exit
	if (!childProcesses) {
		childProcesses = [];
		if (!noKill) {
			const killChildren = () => {
				shuttingDown = true;
				if (!childProcesses) return;
				childProcesses.map((proc) => proc.kill());
				process.exit(0);
			};
			process.on('exit', killChildren);
			process.on('SIGINT', killChildren);
			process.on('SIGQUIT', killChildren);
			process.on('SIGTERM', killChildren);
		}
	}
	childProcesses.push(subprocess);
}
function startWithPM2(procConfig) {
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.start(procConfig, (err, res) => {
			if (err) {
				pm2.disconnect();
				reject(err);
			}
			pm2.disconnect();
			resolve(res);
		});
	});
}

/**
 * Stops a specific service then deletes it from processManagement
 * @param serviceName
 * @returns {Promise<unknown>}
 */
function stop(serviceName) {
	if (!pm2Mode) {
		for (let process of childProcesses || []) {
			if (process.name === serviceName) {
				childProcesses.splice(childProcesses.indexOf(process), 1);
				process.kill();
			}
		}
		return;
	}
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.stop(serviceName, async (err, res) => {
			if (err) {
				pm2.disconnect();
				reject(err);
			}

			// Once the service has stopped, delete it from processManagement
			pm2.delete(serviceName, (delErr, delRes) => {
				if (delErr) {
					pm2.disconnect();
					reject(err);
				}

				pm2.disconnect();
				resolve(delRes);
			});
		});
	});
}

/**
 * rolling restart of clustered processes, NOTE this only works for services in cluster mode like HarperDB
 * @param serviceName
 * @returns {Promise<unknown>}
 */
function reload(serviceName) {
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}

		pm2.reload(serviceName, (err, res) => {
			if (err) {
				pm2.disconnect();
				reject(err);
			}

			pm2.disconnect();
			resolve(res);
		});
	});
}

/**
 * restart processes
 * @param serviceName
 * @returns {Promise<unknown>}
 */
function restart(serviceName) {
	if (!pm2Mode) {
		expectedRestartOfChildren();
		for (let childProcess of childProcesses || []) {
			// kill the child process and let it (auto) restart
			if (childProcess.name === serviceName) {
				childProcess.kill();
			}
		}
	}
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.restart(serviceName, (err, res) => {
			pm2.disconnect();
			resolve(res);
		});
	});
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
 * Delete a process from Pm2
 * @param serviceName
 * @returns {Promise<unknown>}
 */
function deleteProcess(serviceName) {
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.delete(serviceName, (err, res) => {
			if (err) {
				pm2.disconnect();
				reject(err);
			}

			pm2.disconnect();
			resolve(res);
		});
	});
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
 * lists all known processes
 * @returns {Promise<unknown>}
 */
function list() {
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.list((err, res) => {
			if (err) {
				pm2.disconnect();
				reject(err);
			}

			pm2.disconnect();
			resolve(res);
		});
	});
}

/**
 * describes processes for a service
 * @returns {Promise<unknown>}
 */
function describe(serviceName) {
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.describe(serviceName, (err, res) => {
			if (err) {
				pm2.disconnect();
				reject(err);
			}

			pm2.disconnect();
			resolve(res);
		});
	});
}

function kill() {
	if (!pm2Mode) {
		for (let process of childProcesses || []) {
			process.kill();
		}
		childProcesses = [];
		return;
	}

	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.killDaemon((err, res) => {
			if (err) {
				pm2.disconnect();
				reject(err);
			}

			pm2.disconnect();
			resolve(res);
		});
	});
}

/**
 * starts all services based on the servicesConfig
 * @returns {Promise<void>}
 */
async function startAllServices() {
	try {
		// The clustering services are started separately because their config is
		// removed for security reasons after they are connected.
		// Also we create the work queue stream when we start clustering
		await startClusteringProcesses();
		await startClusteringThreads();

		await start(servicesConfig.generateAllServiceConfigs());
	} catch (err) {
		pm2?.disconnect();
		throw err;
	}
}

/**
 * start a specific service
 * @param serviceName
 * @returns {Promise<void>}
 */
async function startService(serviceName, noKill = false) {
	try {
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
		await start(startConfig);
	} catch (err) {
		pm2?.disconnect();
		throw err;
	}
}

/**
 * gets a unique map of running services
 * @returns {Promise<{}>}
 */
async function getUniqueServicesList() {
	try {
		const processes = await list();
		let services = {};
		for (let x = 0, length = processes.length; x < length; x++) {
			let process = processes[x];
			if (services[process.name] === undefined) {
				services[process.name] = {
					name: process.name,
					exec_mode: process.pm2_env.exec_mode,
				};
			}
		}
		return services;
	} catch (err) {
		pm2?.disconnect();
		throw err;
	}
}

/**
 * restart all services, without the option to exclude services from restart.
 * @param excluding
 * @returns {Promise<void>}
 */
async function restartAllServices(excluding = []) {
	try {
		let restart_hdb = false;
		const services = await getUniqueServicesList();
		for (let x = 0, length = Object.values(services).length; x < length; x++) {
			let service = Object.values(services)[x];
			const serviceName = service.name;
			if (excluding.includes(serviceName)) continue;
			//if a service is run in cluster mode we want to reload (rolling restart), non-cluster processes must use restart
			if (serviceName === hdbTerms.PROCESS_DESCRIPTORS.HDB) {
				restart_hdb = true;
			} else {
				await restart(serviceName);
			}
		}

		// We need to do the HarperDB restart last.
		if (restart_hdb) {
			await reloadStopStart(hdbTerms.PROCESS_DESCRIPTORS.HDB);
		}
	} catch (err) {
		pm2?.disconnect();
		throw err;
	}
}

/**
 * Check to see if a service is currently managed by processManagement
 */
async function isServiceRegistered(service) {
	if (childProcesses?.find((childProcess) => childProcess.name === service)) return true;
	const hdbProcs = await sysInfo.getHDBProcessInfo();
	return hdbProcs.core.length && hdbProcs.core[0]?.parent === 'PM2';
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
 * Checks all the processes that make up clustering to see if they are running.
 * All required processes must be running for function to return true.
 * @returns {Promise<boolean>}
 */
async function isClusteringRunning() {
	for (const proc in hdbTerms.CLUSTERING_PROCESSES) {
		const service = hdbTerms.CLUSTERING_PROCESSES[proc];
		const isCurrentlyRunning = await isServiceRegistered(service);
		if (isCurrentlyRunning === false) {
			return false;
		}
	}

	return true;
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
