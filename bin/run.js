'use strict';

const env = require('../utility/environment/environmentManager.js');
env.initSync();

// This unused restart require is here so that main thread loads ITC event listener defined in restart file. Do not remove.
require('./restart.js');
const terms = require('../utility/hdbTerms.ts');
const { CONFIG_PARAMS } = terms;
const hdbLogger = require('../utility/logging/harper_logger.js');
const fs = require('fs-extra');
const path = require('path');
const checkJwtTokens = require('../utility/install/checkJWTTokensExist.js');
const { install } = require('../utility/install/installer.js');
const chalk = require('chalk');
const { packageJson } = require('../utility/packageUtils.js');
const hdbUtils = require('../utility/common_utils.js');
const installation = require('../utility/installation.ts');
const configUtils = require('../config/configUtils.js');
const assignCMDENVVariables = require('../utility/assignCmdEnvVariables.js');
const upgrade = require('./upgrade.js');
const { compactOnStart } = require('./copyDb.ts');
const minimist = require('minimist');
const keys = require('../security/keys.js');
const { startHTTPThreads } = require('../server/threads/socketRouter.ts');
const hdbInfoController = require('../dataLayer/hdbInfoController.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const { getHdbPid } = require('../utility/processManagement/processManagement.js');

let pmUtils;
let cmdArgs;
let skipExitListeners = false;

const UPGRADE_COMPLETE_MSG = 'Upgrade complete.  Starting HarperDB.';
const UPGRADE_ERR = 'Got an error while trying to upgrade your HarperDB instance.  Exiting HarperDB.';
const HDB_NOT_FOUND_MSG = 'HarperDB not found, starting install process.';
const INSTALL_ERR = 'There was an error during install, check install_log.log for more details.  Exiting.';
const HDB_STARTED = 'HarperDB successfully started.';

function addUnhandleRejectionListener() {
	process.on('unhandledRejection', (reason, promise) => {
		hdbLogger.error('Unhandled promise rejection: Promise', promise, 'reason:', reason);
	});
}

function addExitListeners() {
	if (!skipExitListeners) {
		const removeHdbPid = () => {
			fs.removeSync(path.join(env.get(terms.CONFIG_PARAMS.ROOTPATH), terms.HDB_PID_FILE));
			process.exit(0);
		};
		process.on('exit', () => {
			removeHdbPid();
		});
		process.on('SIGINT', () => {
			removeHdbPid();
		});
		process.on('SIGQUIT', () => {
			removeHdbPid();
		});
		process.on('SIGTERM', () => {
			removeHdbPid();
		});
	}
}

/**
 * Do the initial checks and potential upgrades/installation
 * @param calledByInstall
 * @param calledByMain
 * @returns {Promise<void>}
 */
async function initialize(calledByInstall = false, calledByMain = false) {
	// Check to see if HDB is installed, if it isn't we call install.
	console.log(chalk.magenta('Starting HarperDB...'));

	addUnhandleRejectionListener();

	hdbLogger.suppressLogging?.(() => {
		console.log(chalk.magenta('' + fs.readFileSync(path.join(__dirname, '../static/ascii_logo.txt'))));
	});
	hdbLogger.debug('Checking to make sure hdb is installed');
	if (installation.isHdbInstalled(env, hdbLogger) === false) {
		console.log(HDB_NOT_FOUND_MSG);
		try {
			await install();
		} catch (err) {
			console.error(INSTALL_ERR, err);
			hdbLogger.error(err);
			process.exit(1);
		}
	}

	// The called by install check is here because if cmd/env args are passed to install (which calls run when done)
	// we do not need to update/backup the config file on run.
	if (!calledByInstall) {
		// If run is called with cmd/env vars we create a backup of config and update config file.
		const parsedArgs = assignCMDENVVariables(Object.keys(terms.CONFIG_PARAM_MAP), true);
		if (!hdbUtils.isEmpty(parsedArgs) && !hdbUtils.isEmptyOrZeroLength(Object.keys(parsedArgs))) {
			configUtils.updateConfigValue(undefined, undefined, parsedArgs, true, true);
		}
	}

	// Check to see if HarperDB is already running by checking for a pid file
	// If found confirm it matches a currently running processes
	let hdbPid = getHdbPid();
	if (hdbPid) {
		hdbLogger.debug('Error: HarperDB is already running');
		console.error(`Error: HarperDB is already running (pid: ${hdbPid})`);
		process.exit(4);
	}

	addExitListeners();

	if (calledByMain) {
		// Write HarperDB PID to file for tracking purposes
		await fs.writeFile(path.join(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), hdbTerms.HDB_PID_FILE), `${process.pid}`);
	}
	hdbLogger.info('HarperDB PID', process.pid);

	// Check to see if an upgrade is needed based on existing hdbInfo data.  If so, we need to force the user to upgrade
	// before the server can be started.
	let upgradeVers;
	try {
		const updateObj = await hdbInfoController.getVersionUpdateInfo();
		if (updateObj !== undefined) {
			upgradeVers = updateObj[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.UPGRADE_VERSION];
			await upgrade.upgrade(updateObj);
			console.log(UPGRADE_COMPLETE_MSG);
		}
	} catch (err) {
		if (upgradeVers) {
			console.error(
				`Got an error while trying to upgrade your HarperDB instance to version ${upgradeVers}.  Exiting HarperDB.`,
				err
			);
			hdbLogger.error(err);
		} else {
			console.error(UPGRADE_ERR, err);
			hdbLogger.error(err);
		}
		process.exit(1);
	}

	checkJwtTokens();

	await keys.reviewSelfSignedCert();
}
/**
 * Starts Harper DB threads
 * If the hdbBootProps file is not found, it is assumed an install needs to be performed.
 * @param calledByInstall - If run is called by install we want to ignore any
 * cmd/env args as they would have already been written to config on install.
 * @returns {Promise<void>}
 */
async function main(calledByInstall = false) {
	try {
		cmdArgs = minimist(process.argv);
		if (cmdArgs.ROOTPATH) {
			configUtils.updateConfigObject('settings_path', path.join(cmdArgs.ROOTPATH, terms.HDB_CONFIG_FILE));
		}
		await initialize(calledByInstall, true);

		if (env.get(terms.CONFIG_PARAMS.STORAGE_COMPACTONSTART)) await compactOnStart();

		const isScripted = process.env.IS_SCRIPTED_SERVICE && !cmdArgs.service;

		await startHTTPThreads(
			process.env.DEV_MODE
				? 1
				: (env.get(hdbTerms.CONFIG_PARAMS.THREADS_COUNT) ?? env.get(hdbTerms.CONFIG_PARAMS.THREADS))
		);

		if (!isScripted) started();
	} catch (err) {
		console.error(err);
		hdbLogger.error(err);
		process.exit(1);
	}
}
function started() {
	// Console log Harper dog logo
	hdbLogger.suppressLogging(() => {
		console.log(chalk.magenta(`HarperDB ${packageJson.version} successfully started`));
	});
	hdbLogger.notify(HDB_STARTED);
}
/**
 * Launches a separate process for HarperDB and then exits. This is an unusual practice and is anathema
 * to the way processes are typically handled, both in terminal and for services (systemd), but this functionality
 * is retained for legacy purposes.
 * @returns {Promise<void>} // ha ha, it doesn't!
 */
async function launch(exit = true) {
	skipExitListeners = !exit;
	try {
		if (pmUtils === undefined) pmUtils = require('../utility/processManagement/processManagement.js');
		hdbLogger.debug('initializing processManagement...');
		await initialize();
		hdbLogger.debug('Starting new main process');

		await pmUtils.startService(terms.PROCESS_DESCRIPTORS.HDB, true);
		started();
		if (exit) process.exit(0);
	} catch (err) {
		console.error(err);
		hdbLogger.error(err);
		process.exit(1);
	}
}

exports.launch = launch;
exports.main = main;
exports.startupLog = startupLog;

/**
 * Logs running services and relevant ports/information.
 * Called by worker thread 1 once all servers have started
 * @param portResolutions
 */
function startupLog(portResolutions) {
	// Adds padding to a string
	const padding = 20;
	const pad = (param) => param.padEnd(padding);
	let logMsg = '\n';

	logMsg += `${pad('Hostname:')}${env.get(CONFIG_PARAMS.NODE_HOSTNAME)}\n`;

	logMsg += `${pad('Worker Threads:')}${env.get(CONFIG_PARAMS.THREADS_COUNT)}\n`;

	logMsg += `${pad('Root Path:')}${env.get(CONFIG_PARAMS.ROOTPATH)}\n`;

	if (env.get(CONFIG_PARAMS.THREADS_DEBUG) !== false) {
		logMsg += `${pad('Debugging:')}enabled: true`;
		logMsg += env.get(CONFIG_PARAMS.THREADS_DEBUG_PORT)
			? `, TCP: ${env.get(CONFIG_PARAMS.THREADS_DEBUG_PORT)}\n`
			: '\n';
	}
	const logFilePath = path.join(env.get(CONFIG_PARAMS.LOGGING_ROOT), 'hdb.log');
	logMsg += `${pad('Logging:')}level: ${env.get(CONFIG_PARAMS.LOGGING_LEVEL)}, location: ${
		logFilePath + (env.get(CONFIG_PARAMS.LOGGING_STDSTREAMS) ? ', stdout/err' : '')
	}\n`;

	// Database Log aka Applications API aka http (in config)
	logMsg += pad('Default:');
	logMsg += env.get(CONFIG_PARAMS.HTTP_PORT) ? `HTTP (and WS): ${env.get(CONFIG_PARAMS.HTTP_PORT)}, ` : '';
	logMsg += env.get(CONFIG_PARAMS.HTTP_SECUREPORT) ? `HTTPS (and WS): ${env.get(CONFIG_PARAMS.HTTP_SECUREPORT)}, ` : '';
	logMsg += `CORS: ${
		env.get(CONFIG_PARAMS.HTTP_CORS) ? `enabled for ${env.get(CONFIG_PARAMS.HTTP_CORSACCESSLIST)}` : 'disabled'
	}\n`;

	// Operations API Log
	logMsg += pad('Operations API:');
	logMsg += env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT)
		? `HTTP: ${env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT)}, `
		: '';
	logMsg += env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT)
		? `HTTPS: ${env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT)}, `
		: '';
	logMsg += `CORS: ${
		env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORS)
			? `enabled for ${env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST)}`
			: 'disabled'
	}`;
	logMsg += `, unix socket: ${env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET)}\n`;

	// MQTT Log
	logMsg += pad('MQTT:');
	logMsg += env.get(CONFIG_PARAMS.MQTT_NETWORK_PORT) ? `TCP: ${env.get(CONFIG_PARAMS.MQTT_NETWORK_PORT)}, ` : '';
	logMsg += env.get(CONFIG_PARAMS.MQTT_NETWORK_SECUREPORT)
		? `TLS: ${env.get(CONFIG_PARAMS.MQTT_NETWORK_SECUREPORT)}`
		: '';
	logMsg +=
		env.get(CONFIG_PARAMS.MQTT_WEBSOCKET) && env.get(CONFIG_PARAMS.HTTP_PORT)
			? `, WS: ${env.get(CONFIG_PARAMS.HTTP_PORT)}`
			: '';
	logMsg +=
		env.get(CONFIG_PARAMS.MQTT_WEBSOCKET) && env.get(CONFIG_PARAMS.HTTP_SECUREPORT)
			? `, WSS: ${env.get(CONFIG_PARAMS.HTTP_SECUREPORT)}\n`
			: '\n';

	if (env.get(CONFIG_PARAMS.REPLICATION_URL)) {
		let repLog = `${pad('Replication:')}\n`;

		repLog += `${pad('Replication Url:')}${env.get(CONFIG_PARAMS.REPLICATION_URL)}\n`;
		// Replication log
		const replicationPort =
			env.get(CONFIG_PARAMS.REPLICATION_PORT) ?? env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT);
		const replicationSecurePort =
			env.get(CONFIG_PARAMS.REPLICATION_SECUREPORT) ?? env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT);

		repLog += replicationPort ? `WS: ${replicationPort}, ` : '';
		repLog += replicationSecurePort ? `WSS: ${replicationSecurePort}  ` : '';
		logMsg += `${repLog.slice(0, -2)}\n`;
	}

	// Extract all non-default components from the config file
	let components = [];
	const configObj = configUtils.getConfigObj();
	for (const cfg in configObj) {
		if (configObj[cfg].package) components.push(cfg);
	}

	// portResolutions is a Map of port to protocol name and component name built in threadServer.js
	// we iterate through the map to build a log for REST and for any components that are using custom ports
	let comps = {};
	let restLog = `${pad('REST:')}`;
	for (const [key, values] of portResolutions) {
		for (const value of values) {
			const name = value.name;
			if (name === 'rest') {
				restLog += `${value.protocol_name}: ${key}, `;
			}

			if (components.includes(name)) {
				if (comps[name]) {
					comps[name] += `${value.protocol_name}: ${key}, `;
				} else {
					comps[name] = `${value.protocol_name}: ${key}, `;
				}
			}
		}
	}

	// Remove the trailing comma and space
	if (restLog.length > padding + 1) {
		restLog = restLog.slice(0, -2);
		logMsg += `${restLog}\n`;
	}

	let appPortsLog = env.get(CONFIG_PARAMS.HTTP_PORT) ? `HTTP: ${env.get(CONFIG_PARAMS.HTTP_PORT)}, ` : '';
	appPortsLog += env.get(CONFIG_PARAMS.HTTP_SECUREPORT) ? `HTTPS: ${env.get(CONFIG_PARAMS.HTTP_SECUREPORT)}, ` : '';
	if (appPortsLog.length > padding + 1) appPortsLog = appPortsLog.slice(0, -2);

	// Build logs for all components
	for (const c of components) {
		if (comps[c]) {
			logMsg += `${pad(c + ': ')}${comps[c].slice(0, -2)}\n`;
		} else {
			logMsg += `${pad(c + ': ')}${appPortsLog}\n`;
		}
	}

	console.log(logMsg);
	if (env.get(CONFIG_PARAMS.LOGGING_STDSTREAMS) && hdbLogger.logsAtLevel('info')) {
		hdbLogger.suppressLogging(() => {
			console.log(
				`Note that log messages are being sent to the console (stdout and stderr) in addition to the log file ${logFilePath}. This can be disabled by setting logging.stdStreams to false, and the log file can be directly monitored/tailed.`
			);
		});
	}
}
