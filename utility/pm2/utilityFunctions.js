'use strict';

const hdb_terms = require('../hdbTerms');
const hdb_utils = require('../common_utils');
const nats_config = require('../../server/nats/utility/natsConfig');
const nats_utils = require('../../server/nats/utility/natsUtils');
const nats_terms = require('../../server/nats/utility/natsTerms');
const pm2 = require('pm2');
const fs = require('fs-extra');
const services_config = require('./servicesConfig');
const env_mangr = require('../environment/environmentManager');
const hdb_logger = require('../../utility/logging/harper_logger');
const config = require('../../utility/pm2/servicesConfig');
const clustering_utils = require('../clustering/clusterUtilities');
const { startWorker } = require('../../server/threads/start');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const path = require('path');

module.exports = {
	enterScriptingMode,
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
	stopAllServices,
	isServiceRegistered,
	reloadStopStart,
	restartHdb,
	deleteProcess,
	configureLogRotate,
	startClustering,
	isHdbRestartRunning,
	isClusteringRunning,
	stopClustering,
	reloadClustering,
};
const { PACKAGE_ROOT } = require('../hdbTerms');

const PM2_LOGROTATE_VERSION = '2.7.0';
const PM2_MODULE_LOCATION = path.join(PACKAGE_ROOT, 'node_modules/pm2/bin/pm2');
const LOG_ROTATE_INSTALLED = 'Log rotate installed.';
const LOG_ROTATE_INSTALL_ERR = 'Error installing log rotate.';
const LOG_ROTATE_UPDATE = 'Log rotate updated.';
const LOG_ROTATE_UPDATE_ERR = 'Error updating log rotate.';
const RELOAD_HDB_ERR =
	'The number of HarperDB processes running is different from the settings value. ' +
	'To restart and update the number HarperDB processes running you must stop and then start HarperDB';

// This indicates when we are running as a CLI scripting command (kind of taking the place of pm2's CLI), and so we
// are generally starting and stopping processes through PM2.
let scripting_mode = false;

/**
 * Enable scripting mode where we act as the PM2 CLI to start and stop other processes and then exit
 */
function enterScriptingMode() {
	scripting_mode = true;
}
/**
 * Either connects to a running pm2 daemon or launches one.
 * @returns {Promise<unknown>}
 */
function connect() {
	return new Promise((resolve, reject) => {
		pm2.connect(!scripting_mode, (err, res) => {
			if (err) {
				reject(err);
			}

			resolve(res);
		});
	});
}

let processes_to_kill;

/**
 * Starts a service
 * @param proc_config
 * @returns {Promise<unknown>}
 */
function start(proc_config) {
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
			if (!scripting_mode) {
				// if we are running in standard mode, then we want to clean up our child processes when we exit
				if (!processes_to_kill) {
					processes_to_kill = [];
					const kill_child = async () => {
						if (!processes_to_kill) return;
						let finished = processes_to_kill.map(proc_name => new Promise(resolve => {
							pm2.stop(proc_name, (error) => {
								if (error) hdb_logger.warn(`Error terminating process: ${error}`);
								resolve();
							});
						}));
						processes_to_kill = null;
						await Promise.all(finished);
						process.exit(0);
					};
					process.on('exit', kill_child);
					process.on('SIGINT', kill_child);
					process.on('SIGQUIT', kill_child);
				}
				processes_to_kill.push(proc_config.name);
			}
			pm2.disconnect();
			resolve(res);
		});
	});
}

/**
 * Stops a specific service then deletes it from pm2
 * @param service_name
 * @returns {Promise<unknown>}
 */
function stop(service_name) {
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.stop(service_name, (err, res) => {
			if (err) {
				pm2.disconnect();
				reject(err);
			}

			// Once the service has stopped, delete it from pm2
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
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.restart(service_name, (err, res) => {
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
 * To restart HarperDB we use pm2 to fork a process and then call restart from that process.
 * We do this because we were seeing random errors when HDB was calling restart on itself.
 * @returns {Promise<void>}
 */
async function restartHdb() {
	await start(config.generateRestart());
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
		await startClustering();

		await start(services_config.generateAllServiceConfigs());
	} catch (err) {
		pm2.disconnect();
		throw err;
	}
}

/**
 * start a specific service
 * @param service_name
 * @returns {Promise<void>}
 */
async function startService(service_name) {
	try {
		let start_config;
		service_name = service_name.toLowerCase();
		switch (service_name) {
			case hdb_terms.PROCESS_DESCRIPTORS.IPC.toLowerCase():
				start_config = services_config.generateIPCServerConfig();
				break;
			case hdb_terms.PROCESS_DESCRIPTORS.HDB.toLowerCase():
				start_config = services_config.generateMainServerConfig();
				break;
			case hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS.toLowerCase():
				start_config = services_config.generateCFServerConfig();
				break;
			case hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_INGEST_SERVICE.toLowerCase():
				start_config = services_config.generateNatsIngestServiceConfig();
				break;
			case hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_REPLY_SERVICE.toLowerCase():
				start_config = services_config.generateNatsReplyServiceConfig();
				break;
			case hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB.toLowerCase():
				start_config = services_config.generateNatsHubServerConfig();
				await start(start_config);
				// For security reasons remove the Nats servers config file from disk after service has started.
				await nats_config.removeNatsConfig(service_name);
				return;
			case hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF.toLowerCase():
				start_config = services_config.generateNatsLeafServerConfig();
				await start(start_config);
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
		pm2.disconnect();
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
		pm2.disconnect();
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
		pm2.disconnect();
		throw err;
	}
}

/**
 * stops all services then kills the pm2 daemon
 * @returns {Promise<void>}
 */
async function stopAllServices() {
	try {
		const services = await getUniqueServicesList();
		for (let x = 0, length = Object.values(services).length; x < length; x++) {
			let service = Object.values(services)[x];
			await stop(service.name);
		}

		// Kill pm2 daemon
		await kill();

		// If running in foreground get the pid of foreground process and kill it.
		if (env_mangr.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_FOREGROUND) === true) {
			// eslint-disable-next-line prettier/prettier
			const foreground_pid = (
				await fs.readFile(
					path.join(env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY), hdb_terms.FOREGROUND_PID_FILE)
				)
			).toString();
			try {
				process.kill(foreground_pid, 'SIGTERM');
			} catch (pid_err) {
				hdb_logger.warn(`Error terminating foreground process: ${pid_err}`);
			}
		}
	} catch (err) {
		pm2.disconnect();
		throw err;
	}
}

/**
 * Check to see if a service is currently managed by pm2
 */
async function isServiceRegistered(service) {
	return !hdb_utils.isEmptyOrZeroLength(await describe(service));
}

/**
 * Will check the env setting vars to see if there has been a change in number or services running.
 * If no change reload is called. If values have changed, service is stopped and started.
 * @param service_name
 * @returns {Promise<void>}
 */
async function reloadStopStart(service_name) {
	await reload(service_name);
}

/**
 * Stops the pm2-logrotate module but does not delete it like the other stop function does.
 * @returns {Promise<unknown>}
 */
function stopLogrotate() {
	return new Promise(async (resolve, reject) => {
		try {
			await connect();
		} catch (err) {
			reject(err);
		}
		pm2.stop(hdb_terms.PROCESS_DESCRIPTORS.PM2_LOGROTATE, (err, res) => {
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
 * Install pm2's logrotate module.
 * @returns {Promise<void>}
 */
async function installLogRotate() {
	const { stdout, stderr } = await exec(
		`${
			process.platform === 'win32' ? 'node' : ''
		} ${PM2_MODULE_LOCATION} install pm2-logrotate@${PM2_LOGROTATE_VERSION}`
	);
	hdb_logger.debug(`loadLogRotate stdout: ${stdout}`);

	if (stderr) {
		hdb_logger.error(LOG_ROTATE_INSTALL_ERR);
		throw stderr;
	}

	hdb_logger.info(LOG_ROTATE_INSTALLED);
}

/**
 * Update pm2's logrotate module.
 * @returns {Promise<void>}
 */
async function updateLogRotateConfig() {
	const log_rotate_config = {
		max_size: env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_ROTATE_MAX_SIZE),
		retain: env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_ROTATE_RETAIN),
		compress: env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_ROTATE_COMPRESS),
		dateFormat: env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_ROTATE_DATE_FORMAT),
		rotateModule: env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_ROTATE_ROTATE_MODULE),
		workerInterval: env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_ROTATE_WORKER_INTERVAL),
		rotateInterval: env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_ROTATE_ROTATE_INTERVAL),
		TZ: env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_ROTATE_TIMEZONE),
	};

	// Loop through all the rotate config params and build a command that is executed in a child process.
	let update_command = '';
	for (const param in log_rotate_config) {
		update_command += `${
			process.platform === 'win32' ? 'node' : ''
		} ${PM2_MODULE_LOCATION} set pm2-logrotate:${param} ${log_rotate_config[param]}`;
		if (param !== 'TZ') update_command += ' && ';
	}

	const { stdout, stderr } = await exec(update_command);
	hdb_logger.debug(`updateLogRotateConfig stdout: ${stdout}`);

	if (stderr) {
		hdb_logger.error(LOG_ROTATE_UPDATE_ERR);
		throw stderr;
	}

	hdb_logger.info(LOG_ROTATE_UPDATE);
}

/**
 * If pm2-logrotate is already installed, start it. If it isn't, install it.
 * If LOG_ROTATE is set to false and logrotate is online, stop it.
 * After this is done run its config.
 * @returns {Promise<void>}
 */
async function configureLogRotate() {
	env_mangr.initSync();
	const logrotate_env = hdb_utils.autoCastBoolean(env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_ROTATE));
	const logrotate_des = await describe(hdb_terms.PROCESS_DESCRIPTORS.PM2_LOGROTATE);
	let logrotate_status;
	let logrotate_installed = false;
	if (!hdb_utils.isEmptyOrZeroLength(logrotate_des)) {
		logrotate_installed = true;
		logrotate_status = logrotate_des[0].pm2_env.status;
	}

	// If log rotate set to true in settings but not installed, call install.
	if (logrotate_env && !logrotate_installed) {
		await installLogRotate();
		await updateLogRotateConfig();
		return;
	}

	// If log rotate set to true in settings and is installed call start.
	if (logrotate_env && logrotate_installed) {
		await start(hdb_terms.PROCESS_DESCRIPTORS.PM2_LOGROTATE);
		await updateLogRotateConfig();
		return;
	}

	// If log rotate is set to false and it is running, stop it.
	if (!logrotate_env && logrotate_status === hdb_terms.PM2_PROCESS_STATUSES.ONLINE) {
		await stopLogrotate();
	}
}

let ingestWorker;
let replyWorker;
	/**
 * Starts all the services that make up clustering
 * @returns {Promise<void>}
 */
async function startClustering() {
	for (const proc in hdb_terms.CLUSTERING_PROCESSES) {
		const service = hdb_terms.CLUSTERING_PROCESSES[proc];
		if (service === hdb_terms.CLUSTERING_PROCESSES.CLUSTERING_INGEST_PROC_DESCRIPTOR) {
			ingestWorker = startWorker(hdb_terms.LAUNCH_SERVICE_SCRIPTS.NATS_INGEST_SERVICE, { name : service });
		} else if (service === hdb_terms.CLUSTERING_PROCESSES.CLUSTERING_REPLY_SERVICE_DESCRIPTOR) {
			replyWorker = startWorker(hdb_terms.LAUNCH_SERVICE_SCRIPTS.NATS_REPLY_SERVICE, { name : service });
		} else {
			await startService(service);
		}
	}
	await nats_utils.createWorkQueueStream(nats_terms.WORK_QUEUE_CONSUMER_NAMES);

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
			await ingestWorker.terminate();
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
 * This will NOT restart the pm2 process.
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
