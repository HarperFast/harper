'use strict';

const hdb_terms = require('../hdbTerms');
const hdb_utils = require('../common_utils');
const pm2 = require('pm2');
const services_config = require('./servicesConfig');
const env_mangr = require('../environment/environmentManager');
const hdb_logger = require('../../utility/logging/harper_logger');
const config = require('../../utility/pm2/servicesConfig');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const path = require('path');

module.exports = {
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
};

const PM2_LOGROTATE_VERSION = '2.7.0';
const PM2_MODULE_LOCATION = path.resolve(__dirname, '../../node_modules/pm2/bin/pm2');
const LOG_ROTATE_INSTALLED = 'Log rotate installed.';
const LOG_ROTATE_INSTALL_ERR = 'Error installing log rotate.';
const LOG_ROTATE_UPDATE = 'Log rotate updated.';
const LOG_ROTATE_UPDATE_ERR = 'Error updating log rotate.';
const RELOAD_HDB_ERR =
	'The number of HarperDB processes running is different from the settings value. ' +
	'To restart and update the number HarperDB processes running you must stop and then start HarperDB';

/**
 * Either connects to a running pm2 daemon or launches one.
 * @returns {Promise<unknown>}
 */
function connect() {
	return new Promise((resolve, reject) => {
		pm2.connect((err, res) => {
			if (err) {
				reject(err);
			}

			resolve(res);
		});
	});
}

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
		switch (service_name.toLowerCase()) {
			case hdb_terms.PROCESS_DESCRIPTORS.IPC.toLowerCase():
				start_config = services_config.generateIPCServerConfig();
				break;
			case hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING.toLowerCase():
				start_config = services_config.generateClusteringServerConfig();
				break;
			case hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_CONNECTOR.toLowerCase():
				start_config = services_config.generateClusteringConnectorConfig();
				break;
			case hdb_terms.PROCESS_DESCRIPTORS.HDB.toLowerCase():
				start_config = services_config.generateHDBServerConfig();
				break;
			case hdb_terms.PROCESS_DESCRIPTORS.CUSTOM_FUNCTIONS.toLowerCase():
				start_config = services_config.generateCFServerConfig();
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
			if (service.exec_mode === 'cluster_mode') {
				if (service_name === hdb_terms.PROCESS_DESCRIPTORS.HDB) {
					restart_hdb = true;
				} else {
					await reloadStopStart(service_name);
				}
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
 * stops all services
 * @returns {Promise<void>}
 */
async function stopAllServices() {
	try {
		const services = await getUniqueServicesList();
		for (let x = 0, length = Object.values(services).length; x < length; x++) {
			let service = Object.values(services)[x];
			if (service.name === hdb_terms.PROCESS_DESCRIPTORS.PM2_LOGROTATE) await stopLogrotate();
			else await stop(service.name);
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
	// Check to see if there has been an update to the max process setting value. If there has been we need to stop the service and start it again.
	const setting_process_count =
		service_name === hdb_terms.PROCESS_DESCRIPTORS.HDB
			? env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES)
			: env_mangr.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_CUSTOM_FUNCTION_PROCESSES);
	const current_process = await describe(service_name);
	const current_process_count = hdb_utils.isEmptyOrZeroLength(current_process) ? 0 : current_process.length;
	if (setting_process_count !== current_process_count) {
		if (service_name === hdb_terms.PROCESS_DESCRIPTORS.HDB) {
			hdb_logger.error(RELOAD_HDB_ERR);
		} else {
			await stop(service_name);
			await startService(service_name);
		}
	} else if (service_name === hdb_terms.PROCESS_DESCRIPTORS.HDB) {
		// To restart HDB we need to fork a temp process which calls restart.
		await restartHdb();
	} else {
		// If no change to the max process values just call reload.
		await reload(service_name);
	}
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
	const { stdout, stderr } = await exec(`${PM2_MODULE_LOCATION} install pm2-logrotate@${PM2_LOGROTATE_VERSION}`);
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
		update_command += `${PM2_MODULE_LOCATION} set pm2-logrotate:${param} ${log_rotate_config[param]}`;
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
