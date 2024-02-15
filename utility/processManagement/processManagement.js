'use strict';

const hdb_terms = require('../hdbTerms');
const hdb_utils = require('../common_utils');
const nats_config = require('../../server/nats/utility/natsConfig');
const nats_utils = require('../../server/nats/utility/natsUtils');
const nats_terms = require('../../server/nats/utility/natsTerms');
const services_config = require('./servicesConfig');
const env_mangr = require('../environment/environmentManager');
const hdb_logger = require('../../utility/logging/harper_logger');
const clustering_utils = require('../clustering/clusterUtilities');
const { startWorker, onMessageFromWorkers } = require('../../server/threads/manageThreads');
const sys_info = require('../environment/systemInformation');
const util = require('util');
const child_process = require('child_process');
const fs = require('fs');
const { execFile } = child_process;

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
};

// This indicates when we are running as a CLI scripting command (kind of taking the place of processManagement's CLI), and so we
// are generally starting and stopping processes through PM2.
let pm2_mode = false;

onMessageFromWorkers((message) => {
	if (message.type === 'restart') env_mangr.initSync(true);
});

/**
 * Enable scripting mode where we act as the PM2 CLI to start and stop other processes and then exit
 */
function enterPM2Mode() {
	pm2_mode = true;
}
/**
 * Either connects to a running processManagement daemon or launches one.
 * @returns {Promise<unknown>}
 */
function connect() {
	if (!pm2) pm2 = require('pm2');
	return new Promise((resolve, reject) => {
		pm2.connect((err, res) => {
			// PM2 tries to take over logging. We are not going to be defeated, we are taking it back!
			hdb_logger.setupConsoleLogging();
			if (err) {
				reject(err);
			}

			resolve(res);
		});
	});
}

let child_processes;
const MAX_RESTARTS = 10;
let shutting_down;
/**
 * Starts a service
 * @param proc_config
 * @returns {Promise<unknown>}
 */
function start(proc_config, no_kill = false) {
	if (pm2_mode) return startWithPM2(proc_config);
	let subprocess = execFile(proc_config.script, proc_config.args.split(' '), proc_config);
	subprocess.name = proc_config.name;
	subprocess.on('exit', async (code) => {
		let index = child_processes.indexOf(subprocess); // dead, remove it from processes to kill now
		if (index > -1) child_processes.splice(index, 1);
		if (!shutting_down && code !== 0) {
			proc_config.restarts = (proc_config.restarts || 0) + 1;
			// restart the child process
			if (proc_config.restarts < MAX_RESTARTS) {
				if (!fs.existsSync(nats_config.getHubConfigPath())) {
					await nats_config.generateNatsConfig(true);
					start(proc_config);
					await new Promise((resolve) => setTimeout(resolve, 3000));
					await nats_config.removeNatsConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB);
					await nats_config.removeNatsConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
				} else start(proc_config);
			}
		}
	});
	const SERVICE_DEFINITION = {
		serviceName: proc_config.name.replace(/ /g, '-'),
	};
	function extractMessages(log) {
		const CLUSTERING_LOG_LEVEL = env_mangr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LOGLEVEL);
		let NATS_PARSER = /\[\d+][^\[]+\[(\w+)]/g;
		let log_start,
			last_position = 0,
			last_level;
		while ((log_start = NATS_PARSER.exec(log))) {
			// Only log if level is at or above clustering log level
			if (
				log_start.index &&
				nats_terms.LOG_LEVEL_HIERARCHY[CLUSTERING_LOG_LEVEL] >= nats_terms.LOG_LEVEL_HIERARCHY[last_level || 'info']
			) {
				const output =
					last_level === nats_terms.LOG_LEVELS.ERR || last_level === nats_terms.LOG_LEVELS.WRN
						? hdb_logger.OUTPUTS.STDERR
						: hdb_logger.OUTPUTS.STDOUT;

				hdb_logger.logCustomLevel(
					last_level || 'info',
					output,
					SERVICE_DEFINITION,
					log.slice(last_position, log_start.index).trim()
				);
			}

			let [start_text, level] = log_start;
			last_position = log_start.index + start_text.length;
			last_level = nats_terms.LOG_LEVELS[level];
		}

		// Only log if level is at or above clustering log level
		if (nats_terms.LOG_LEVEL_HIERARCHY[CLUSTERING_LOG_LEVEL] >= nats_terms.LOG_LEVEL_HIERARCHY[last_level || 'info']) {
			const output =
				last_level === nats_terms.LOG_LEVELS.ERR || last_level === nats_terms.LOG_LEVELS.WRN
					? hdb_logger.OUTPUTS.STDERR
					: hdb_logger.OUTPUTS.STDOUT;

			hdb_logger.logCustomLevel(last_level || 'info', output, SERVICE_DEFINITION, log.slice(last_position).trim());
		}
	}
	subprocess.stdout.on('data', extractMessages);
	subprocess.stderr.on('data', extractMessages);
	subprocess.unref();

	// if we are running in standard mode, then we want to clean up our child processes when we exit
	child_processes = [];
	if (!child_processes && !no_kill) {
		const kill_children = () => {
			shutting_down = true;
			if (!child_processes) return;
			child_processes.map((proc) => proc.kill());
			process.exit(0);
		};
		process.on('exit', kill_children);
		process.on('SIGINT', kill_children);
		process.on('SIGQUIT', kill_children);
		process.on('SIGTERM', kill_children);
	}
	child_processes.push(subprocess);
}
function startWithPM2(proc_config) {
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.start(proc_config, (err, res) => {
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
 * @param service_name
 * @returns {Promise<unknown>}
 */
function stop(service_name) {
	if (!pm2_mode) {
		for (let process of child_processes || []) {
			if (process.name === service_name) {
				child_processes.splice(child_processes.indexOf(process), 1);
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
		pm2.stop(service_name, async (err, res) => {
			if (err) {
				pm2.disconnect();
				reject(err);
			}

			// Once the service has stopped, delete it from processManagement
			pm2.delete(service_name, (del_err, del_res) => {
				if (del_err) {
					pm2.disconnect();
					reject(err);
				}

				pm2.disconnect();
				resolve(del_res);
			});
		});
	});
}

/**
 * rolling restart of clustered processes, NOTE this only works for services in cluster mode like HarperDB
 * @param service_name
 * @returns {Promise<unknown>}
 */
function reload(service_name) {
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}

		pm2.reload(service_name, (err, res) => {
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
 * @param service_name
 * @returns {Promise<unknown>}
 */
function restart(service_name) {
	if (!pm2_mode) {
		for (let child_process of child_processes || []) {
			// kill the child process and let it (auto) restart
			if (child_process.name === service_name) {
				child_process.kill();
			}
		}
	}
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.restart(service_name, (err, res) => {
			pm2.disconnect();
			resolve(res);
		});
	});
}

/**
 * Delete a process from Pm2
 * @param service_name
 * @returns {Promise<unknown>}
 */
function deleteProcess(service_name) {
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.delete(service_name, (err, res) => {
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
	await start(services_config.generateRestart());
}

/**
 * Checks to see if the HDB restart script is currently running.
 * @returns {Promise<boolean>}
 */
async function isHdbRestartRunning() {
	const all_processes = await list();
	for (const p in all_processes) {
		const proc = all_processes[p];
		if (proc.name === hdb_terms.PROCESS_DESCRIPTORS.RESTART_HDB) {
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
function describe(service_name) {
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.describe(service_name, (err, res) => {
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
	if (!pm2_mode) {
		for (let process of child_processes || []) {
			process.kill();
		}
		child_processes = [];
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

		await start(services_config.generateAllServiceConfigs());
	} catch (err) {
		pm2?.disconnect();
		throw err;
	}
}

/**
 * start a specific service
 * @param service_name
 * @returns {Promise<void>}
 */
async function startService(service_name, no_kill = false) {
	try {
		let start_config;
		service_name = service_name.toLowerCase();
		switch (service_name) {
			case hdb_terms.PROCESS_DESCRIPTORS.HDB.toLowerCase():
				start_config = services_config.generateMainServerConfig();
				break;
			case hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_INGEST_SERVICE.toLowerCase():
				start_config = services_config.generateNatsIngestServiceConfig();
				break;
			case hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_REPLY_SERVICE.toLowerCase():
				start_config = services_config.generateNatsReplyServiceConfig();
				break;
			case hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB.toLowerCase():
				start_config = services_config.generateNatsHubServerConfig();
				await start(start_config, no_kill);
				// For security reasons remove the Nats servers config file from disk after service has started.
				await nats_config.removeNatsConfig(service_name);
				return;
			case hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF.toLowerCase():
				start_config = services_config.generateNatsLeafServerConfig();
				await start(start_config, no_kill);
				// For security reasons remove the Nats servers config file from disk after service has started.
				await nats_config.removeNatsConfig(service_name);
				return;
			case hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_UPGRADE_4_0_0.toLowerCase():
				start_config = services_config.generateClusteringUpgradeV4ServiceConfig();
				break;
			default:
				throw new Error(`Start service called with unknown service config: ${service_name}`);
		}
		await start(start_config);
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
			const service_name = service.name;
			if (excluding.includes(service_name)) continue;
			//if a service is run in cluster mode we want to reload (rolling restart), non-cluster processes must use restart
			if (service_name === hdb_terms.PROCESS_DESCRIPTORS.HDB) {
				restart_hdb = true;
			} else {
				await restart(service_name);
			}
		}

		// We need to do the HarperDB restart last.
		if (restart_hdb) {
			await reloadStopStart(hdb_terms.PROCESS_DESCRIPTORS.HDB);
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
	if (child_processes?.find((child_process) => child_process.name === service)) return true;
	const hdb_procs = await sys_info.getHDBProcessInfo();
	return hdb_procs.core.length && hdb_procs.core[0]?.parent === 'PM2';
}

/**
 * Will check the env setting vars to see if there has been a change in number or services running.
 * If no change reload is called. If values have changed, service is stopped and started.
 * @param service_name
 * @returns {Promise<void>}
 */
async function reloadStopStart(service_name) {
	// Check to see if there has been an update to the max process setting value. If there has been we need to stop the service and start it again.
	const setting_process_count =
		env_mangr.get(hdb_terms.CONFIG_PARAMS.THREADS_COUNT) ?? env_mangr.get(hdb_terms.CONFIG_PARAMS.THREADS);
	const current_process = await describe(service_name);
	const current_process_count = hdb_utils.isEmptyOrZeroLength(current_process) ? 0 : current_process.length;
	if (setting_process_count !== current_process_count) {
		await stop(service_name);
		await startService(service_name);
	} else if (service_name === hdb_terms.PROCESS_DESCRIPTORS.HDB) {
		// To restart HDB we need to fork a temp process which calls restart.
		await restartHdb();
	} else {
		// If no change to the max process values just call reload.
		await reload(service_name);
	}
}

let ingestWorker;
let replyWorker;
/**
 * Starts all the processes that make up clustering
 * @returns {Promise<void>}
 */
async function startClusteringProcesses(no_kill = false) {
	for (const proc in hdb_terms.CLUSTERING_PROCESSES) {
		const service = hdb_terms.CLUSTERING_PROCESSES[proc];
		await startService(service, no_kill);
	}
}
/**
 * Starts all the threads that make up clustering
 * @returns {Promise<void>}
 */
async function startClusteringThreads() {
	replyWorker = startWorker(hdb_terms.LAUNCH_SERVICE_SCRIPTS.NATS_REPLY_SERVICE, {
		name: hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_REPLY_SERVICE,
	});

	// There was an update to our nats logic where we stopped using the work queue stream.
	// This code is here to delete it if it still exists.
	try {
		await nats_utils.deleteLocalStream('__HARPERDB_WORK_QUEUE__');
	} catch (err) {}

	// Check to see if the node name or purge config has been updated,
	// if it has we need to change config on any local streams.
	await nats_utils.updateLocalStreams();

	// If any node records are marked as pre 4.0.0 version start process to re-establish node connections.
	const nodes = await clustering_utils.getAllNodeRecords();
	for (let i = 0, rec_length = nodes.length; i < rec_length; i++) {
		if (nodes[i].system_info?.hdb_version === hdb_terms.PRE_4_0_0_VERSION) {
			hdb_logger.info('Starting clustering upgrade 4.0.0 process');
			startWorker(hdb_terms.LAUNCH_SERVICE_SCRIPTS.NODES_UPGRADE_4_0_0, { name: 'Upgrade-4-0-0' });
			break;
		}
	}
}

/**
 * Stop all the services that make up clustering
 */
async function stopClustering() {
	for (const proc in hdb_terms.CLUSTERING_PROCESSES) {
		if (proc === hdb_terms.CLUSTERING_PROCESSES.CLUSTERING_INGEST_PROC_DESCRIPTOR) {
			// TODO: send a broadcast so worker threads that are doing subscribers can stop their subscription
		} else if (proc === hdb_terms.CLUSTERING_PROCESSES.CLUSTERING_REPLY_SERVICE_DESCRIPTOR) {
			await replyWorker.terminate();
		} else {
			const service = hdb_terms.CLUSTERING_PROCESSES[proc];
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
	for (const proc in hdb_terms.CLUSTERING_PROCESSES) {
		const service = hdb_terms.CLUSTERING_PROCESSES[proc];
		const is_currently_running = await isServiceRegistered(service);
		if (is_currently_running === false) {
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
	await nats_config.generateNatsConfig(true);
	await nats_utils.reloadNATSHub();
	await nats_utils.reloadNATSLeaf();

	// For security reasons remove the Hub & Leaf config after they have been reloaded
	await nats_config.removeNatsConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB.toLowerCase());
	await nats_config.removeNatsConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF.toLowerCase());
}
