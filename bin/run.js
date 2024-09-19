'use strict';

const env = require('../utility/environment/environmentManager');
env.initSync();

// This unused restart require is here so that main thread loads ITC event listener defined in restart file. Do not remove.
const restart = require('./restart');
const terms = require('../utility/hdbTerms');
const hdb_logger = require('../utility/logging/harper_logger');
const fs = require('fs-extra');
const path = require('path');
const si = require('systeminformation');
const check_jwt_tokens = require('../utility/install/checkJWTTokensExist');
const { install } = require('../utility/install/installer');
const chalk = require('chalk');
const pjson = require('../package.json');
const hdb_utils = require('../utility/common_utils');
const config_utils = require('../config/configUtils');
const assignCMDENVVariables = require('../utility/assignCmdEnvVariables');
const nats_config = require('../server/nats/utility/natsConfig');
const upgrade = require('./upgrade');
const log_rotator = require('../utility/logging/logRotator');
const { compactOnStart } = require('./copyDb');
const minimist = require('minimist');
const keys = require('../security/keys');
const { PACKAGE_ROOT, CONFIG_PARAMS } = require('../utility/hdbTerms');
const {
	startHTTPThreads,
	startSocketServer,
	mostIdleRouting,
	remoteAffinityRouting,
} = require('../server/threads/socketRouter');

const hdbInfoController = require('../dataLayer/hdbInfoController');
const { isMainThread } = require('worker_threads');

const SYSTEM_SCHEMA = require('../json/systemSchema.json');
const schema_describe = require('../dataLayer/schemaDescribe');
const lmdb_create_txn_environment = require('../dataLayer/harperBridge/lmdbBridge/lmdbUtility/lmdbCreateTransactionsAuditEnvironment');
const CreateTableObject = require('../dataLayer/CreateTableObject');
const hdb_terms = require('../utility/hdbTerms');

let pm_utils;
let cmd_args;
let skip_exit_listeners = false;

// These may change to match unix return codes (i.e. 0, 1)
const ENOENT_ERR_CODE = -2;

const UPGRADE_COMPLETE_MSG = 'Upgrade complete.  Starting HarperDB.';
const UPGRADE_ERR = 'Got an error while trying to upgrade your HarperDB instance.  Exiting HarperDB.';
const HDB_NOT_FOUND_MSG = 'HarperDB not found, starting install process.';
const INSTALL_ERR = 'There was an error during install, check install_log.log for more details.  Exiting.';
const HDB_STARTED = 'HarperDB successfully started.';

function addExitListeners() {
	if (!skip_exit_listeners) {
		const remove_hdb_pid = () => {
			fs.removeSync(path.join(env.get(terms.CONFIG_PARAMS.ROOTPATH), terms.HDB_PID_FILE));
			process.exit(0);
		};
		process.on('exit', () => {
			remove_hdb_pid();
		});
		process.on('SIGINT', () => {
			remove_hdb_pid();
		});
		process.on('SIGQUIT', () => {
			remove_hdb_pid();
		});
		process.on('SIGTERM', () => {
			remove_hdb_pid();
		});
	}
}

/**
 * Do the initial checks and potential upgrades/installation
 * @param called_by_install
 * @returns {Promise<void>}
 */
async function initialize(called_by_install = false, called_by_main = false) {
	// Check to see if HDB is installed, if it isn't we call install.
	console.log(chalk.magenta('Starting HarperDB...'));
	hdb_logger.suppressLogging(() => {
		console.log(chalk.magenta('' + fs.readFileSync(path.join(PACKAGE_ROOT, 'utility/install/ascii_logo.txt'))));
	});

	if ((await isHdbInstalled()) === false) {
		console.log(HDB_NOT_FOUND_MSG);
		try {
			await install();
		} catch (err) {
			console.error(INSTALL_ERR, err);
			hdb_logger.error(err);
			process.exit(1);
		}
	}

	// The called by install check is here because if cmd/env args are passed to install (which calls run when done)
	// we do not need to update/backup the config file on run.
	if (!called_by_install) {
		// If run is called with cmd/env vars we create a backup of config and update config file.
		const parsed_args = assignCMDENVVariables(Object.keys(terms.CONFIG_PARAM_MAP), true);
		if (!hdb_utils.isEmpty(parsed_args) && !hdb_utils.isEmptyOrZeroLength(Object.keys(parsed_args))) {
			config_utils.updateConfigValue(undefined, undefined, parsed_args, true, true);
		}
	}

	// Check to see if HarperDB is already running by checking for a pid file
	// If found confirm it matches a currently running processes
	let is_hdb_running;
	let service_clustering = cmd_args?.service === 'clustering';
	if (cmd_args?.service && !service_clustering) {
		console.error('Unrecognized service argument');
		process.exit(1);
	}

	try {
		const hdb_pid = Number.parseInt(
			await fs.readFile(path.join(env.get(terms.CONFIG_PARAMS.ROOTPATH), terms.HDB_PID_FILE), 'utf8')
		);
		let processes = await si.processes();
		for (const p of processes.list) {
			if (p.pid === hdb_pid) {
				if (!service_clustering) {
					console.log('HarperDB appears to be already running.');
				} else {
					is_hdb_running = true;
				}
				break;
			}
		}
	} catch (err) {
		// Ignore error, If readFile finds no pid file we can assume that HDB is not already running
	}

	// Requiring the processManagement mod will create the .pm2 dir. This code is here to allow install to set
	// pm2 env vars before that is done.
	if (pm_utils === undefined) pm_utils = require('../utility/processManagement/processManagement');

	if (service_clustering) {
		if (!is_hdb_running) {
			console.error('HarperDB must be running to start clustering.');
			process.exit();
		}

		if (!env.get(terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY)) {
			console.error('Clustering must be setup and enabled in harperdb-config.');
			process.exit();
		}

		// Start all services that are required for clustering
		console.log('Starting clustering.');
		await nats_config.generateNatsConfig();
		await pm_utils.startClusteringProcesses(true);
		process.exit();
	}

	addExitListeners();

	// Write HarperDB PID to file for tracking purposes
	await fs.writeFile(path.join(env.get(hdb_terms.CONFIG_PARAMS.ROOTPATH), hdb_terms.HDB_PID_FILE), `${process.pid}`);
	hdb_logger.info('HarperDB PID', process.pid);

	// Check to see if an upgrade is needed based on existing hdb_info data.  If so, we need to force the user to upgrade
	// before the server can be started.
	let upgrade_vers;
	try {
		const update_obj = await hdbInfoController.getVersionUpdateInfo();
		if (update_obj !== undefined) {
			upgrade_vers = update_obj[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.UPGRADE_VERSION];
			await upgrade.upgrade(update_obj);
			console.log(UPGRADE_COMPLETE_MSG);
		}
	} catch (err) {
		if (upgrade_vers) {
			console.error(
				`Got an error while trying to upgrade your HarperDB instance to version ${upgrade_vers}.  Exiting HarperDB.`,
				err
			);
			hdb_logger.error(err);
		} else {
			console.error(UPGRADE_ERR, err);
			hdb_logger.error(err);
		}
		process.exit(1);
	}

	check_jwt_tokens();
	writeLicenseFromVars();

	await keys.reviewSelfSignedCert();

	const clustering_enabled = hdb_utils.autoCastBoolean(env.get(terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY));
	if (clustering_enabled && isMainThread) {
		await nats_config.generateNatsConfig(called_by_main);
	}
}
/**
 * Starts Harper DB threads
 * If the hdb_boot_props file is not found, it is assumed an install needs to be performed.
 * @param called_by_install - If run is called by install we want to ignore any
 * cmd/env args as they would have already been written to config on install.
 * @returns {Promise<void>}
 */
async function main(called_by_install = false) {
	try {
		cmd_args = minimist(process.argv);
		if (cmd_args.ROOTPATH) {
			config_utils.updateConfigObject('settings_path', path.join(cmd_args.ROOTPATH, terms.HDB_CONFIG_FILE));
		}
		await initialize(called_by_install, true);

		if (env.get(terms.CONFIG_PARAMS.STORAGE_COMPACTONSTART)) await compactOnStart();

		const is_scripted = process.env.IS_SCRIPTED_SERVICE && !cmd_args.service;

		if (hdb_utils.autoCastBoolean(env.get(terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY))) {
			if (!is_scripted) await pm_utils.startClusteringProcesses();
			await pm_utils.startClusteringThreads();
		}
		await startHTTPThreads(
			process.env.DEV_MODE
				? 1
				: (env.get(hdb_terms.CONFIG_PARAMS.THREADS_COUNT) ?? env.get(hdb_terms.CONFIG_PARAMS.THREADS))
		);

		if (env.get(terms.CONFIG_PARAMS.LOGGING_ROTATION_ENABLED)) await log_rotator();
		if (!is_scripted) started();
	} catch (err) {
		console.error(err);
		hdb_logger.error(err);
		process.exit(1);
	}
}
function started() {
	// Console log Harper dog logo
	hdb_logger.suppressLogging(() => {
		console.log(chalk.magenta(`HarperDB ${pjson.version} successfully started`));
	});
	hdb_logger.notify(HDB_STARTED);
}
/**
 * Launches a separate process for HarperDB and then exits. This is an unusual practice and is anathema
 * to the way processes are typically handled, both in terminal and for services (systemd), but this functionality
 * is retained for legacy purposes.
 * @returns {Promise<void>} // ha ha, it doesn't!
 */
async function launch(exit = true) {
	skip_exit_listeners = !exit;
	try {
		if (pm_utils === undefined) pm_utils = require('../utility/processManagement/processManagement');
		pm_utils.enterPM2Mode();
		await initialize();
		const clustering_enabled = hdb_utils.autoCastBoolean(env.get(terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY));
		if (clustering_enabled) await pm_utils.startClusteringProcesses();
		await pm_utils.startService(terms.PROCESS_DESCRIPTORS.HDB);
		started();
		if (exit) process.exit(0);
	} catch (err) {
		console.error(err);
		hdb_logger.error(err);
		process.exit(1);
	}
}

/**
 * This function looks for HARPERDB_FINGERPRINT & HARPERDB_LICENSE in env / cmd.
 * If both are found the values will be written to the fingerprint / license files
 */
function writeLicenseFromVars() {
	const LICENSE_PATH = path.join(
		env.get(terms.CONFIG_PARAMS.ROOTPATH),
		terms.LICENSE_KEY_DIR_NAME,
		terms.LICENSE_FILE_NAME
	);
	const LICENSE_FILE = path.join(LICENSE_PATH, terms.LICENSE_FILE_NAME);
	const FINGER_PRINT_FILE = path.join(LICENSE_PATH, terms.REG_KEY_FILE_NAME);

	try {
		const { HARPERDB_FINGERPRINT, HARPERDB_LICENSE } = assignCMDENVVariables([
			'HARPERDB_FINGERPRINT',
			'HARPERDB_LICENSE',
		]);
		if (hdb_utils.isEmpty(HARPERDB_FINGERPRINT) || hdb_utils.isEmpty(HARPERDB_LICENSE)) {
			return;
		}

		fs.mkdirpSync(LICENSE_PATH);
		fs.writeFileSync(FINGER_PRINT_FILE, HARPERDB_FINGERPRINT);
		fs.writeFileSync(LICENSE_FILE, HARPERDB_LICENSE);
	} catch (e) {
		const ERROR_MSG = `Failed to write license & fingerprint due to: ${e.message}`;
		console.error(ERROR_MSG);
		hdb_logger.error(ERROR_MSG);
	}
}

/**
 * iterates the system schema & all other schemas and makes sure there is a transaction audit environment for the schema.table
 * @returns {Promise<void>}
 */
async function checkAuditLogEnvironmentsExist() {
	if (env.getHdbBasePath() !== undefined) {
		hdb_logger.info('Checking Transaction Audit Environments exist');

		for (const table_name of Object.keys(SYSTEM_SCHEMA)) {
			await openCreateAuditEnvironment(terms.SYSTEM_SCHEMA_NAME, table_name);
		}

		let describe_results = await schema_describe.describeAll();

		for (const schema_name of Object.keys(describe_results)) {
			for (const table_name of Object.keys(describe_results[schema_name])) {
				await openCreateAuditEnvironment(schema_name, table_name);
			}
		}

		hdb_logger.info('Finished checking Transaction Audit Environments exist');
	}
}

/**
 * runs the create environment command for the specified schema.table
 * @param {string} schema
 * @param {string} table_name
 * @returns {Promise<void>}
 */
async function openCreateAuditEnvironment(schema, table_name) {
	try {
		let create_tbl_obj = new CreateTableObject(schema, table_name);
		await lmdb_create_txn_environment(create_tbl_obj);
	} catch (e) {
		let error_msg = `Unable to create the transaction audit environment for ${schema}.${table_name}, due to: ${e.message}`;
		console.error(error_msg);
		hdb_logger.error(error_msg);
	}
}

Object.assign(exports, {
	launch,
	main,
	isHdbInstalled,
	startupLog,
});

/**
 *
 * @returns {Promise<boolean>}
 */
async function isHdbInstalled() {
	try {
		await fs.stat(hdb_utils.getPropsFilePath());
		await fs.stat(env.get(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
	} catch (err) {
		if (hdb_utils.noBootFile()) return true;
		if (err.code === 'ENOENT') {
			// boot props not found, hdb not installed
			return false;
		}

		hdb_logger.error(`Error checking for HDB install - ${err}`);
		throw err;
	}

	return true;
}

/**
 * Logs running services and relevant ports/information.
 * Called by worker thread 1 once all servers have started
 * @param port_resolutions
 */
function startupLog(port_resolutions) {
	// Adds padding to a string
	const padding = 20;
	const pad = (param) => param.padEnd(padding);
	let log_msg = '\n';
	if (env.get(CONFIG_PARAMS.REPLICATION_HOSTNAME))
		log_msg += `${pad('Hostname:')}${env.get(CONFIG_PARAMS.REPLICATION_HOSTNAME)}\n`;

	if (env.get(CONFIG_PARAMS.REPLICATION_URL))
		log_msg += `${pad('Replication Url:')}${env.get(CONFIG_PARAMS.REPLICATION_URL)}\n`;

	log_msg += `${pad('Worker Threads:')}${env.get(CONFIG_PARAMS.THREADS_COUNT)}\n`;

	log_msg += `${pad('Root Path:')}${env.get(CONFIG_PARAMS.ROOTPATH)}\n`;

	if (env.get(CONFIG_PARAMS.THREADS_DEBUG) !== false) {
		log_msg += `${pad('Debugging:')}enabled: true`;
		log_msg += env.get(CONFIG_PARAMS.THREADS_DEBUG_PORT)
			? `, TCP: ${env.get(CONFIG_PARAMS.THREADS_DEBUG_PORT)}\n`
			: '\n';
	}

	log_msg += `${pad('Logging:')}level: ${env.get(CONFIG_PARAMS.LOGGING_LEVEL)}, location: ${env.get(
		CONFIG_PARAMS.LOGGING_ROOT
	)}\n`;

	// Database Log aka Applications API aka http (in config)
	log_msg += pad('Default:');
	log_msg += env.get(CONFIG_PARAMS.HTTP_PORT) ? `HTTP (and WS): ${env.get(CONFIG_PARAMS.HTTP_PORT)}, ` : '';
	log_msg += env.get(CONFIG_PARAMS.HTTP_SECUREPORT)
		? `HTTPS (and WS): ${env.get(CONFIG_PARAMS.HTTP_SECUREPORT)}, `
		: '';
	log_msg += `CORS: ${
		env.get(CONFIG_PARAMS.HTTP_CORS) ? `enabled for ${env.get(CONFIG_PARAMS.HTTP_CORSACCESSLIST)}` : 'disabled'
	}\n`;

	// Operations API Log
	log_msg += pad('Operations API:');
	log_msg += env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT)
		? `HTTP: ${env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT)}, `
		: '';
	log_msg += env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT)
		? `HTTPS: ${env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT)}, `
		: '';
	log_msg += `CORS: ${
		env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORS)
			? `enabled for ${env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST)}`
			: 'disabled'
	}`;
	log_msg += `, unix socket: ${env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET)}\n`;

	// MQTT Log
	log_msg += pad('MQTT:');
	log_msg += env.get(CONFIG_PARAMS.MQTT_NETWORK_PORT) ? `TCP: ${env.get(CONFIG_PARAMS.MQTT_NETWORK_PORT)}, ` : '';
	log_msg += env.get(CONFIG_PARAMS.MQTT_NETWORK_SECUREPORT)
		? `TLS: ${env.get(CONFIG_PARAMS.MQTT_NETWORK_SECUREPORT)}`
		: '';
	log_msg +=
		env.get(CONFIG_PARAMS.MQTT_WEBSOCKET) && env.get(CONFIG_PARAMS.HTTP_PORT)
			? `, WS: ${env.get(CONFIG_PARAMS.HTTP_PORT)}`
			: '';
	log_msg +=
		env.get(CONFIG_PARAMS.MQTT_WEBSOCKET) && env.get(CONFIG_PARAMS.HTTP_SECUREPORT)
			? `, WSS: ${env.get(CONFIG_PARAMS.HTTP_SECUREPORT)}\n`
			: '\n';

	// Replication log
	const replication_port = env.get(CONFIG_PARAMS.REPLICATION_PORT) ?? env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT);
	const replication_secure_port =
		env.get(CONFIG_PARAMS.REPLICATION_SECUREPORT) ?? env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT);

	let rep_log = pad('Replication:');
	rep_log += replication_port ? `WS: ${replication_port}, ` : '';
	rep_log += replication_secure_port ? `WSS: ${replication_secure_port}  ` : '';

	log_msg += `${rep_log.slice(0, -2)}\n`;

	// Extract all non-default components from the config file
	let components = [];
	const config_obj = config_utils.getConfigObj();
	for (const cfg in config_obj) {
		if (config_obj[cfg].package) components.push(cfg);
	}

	// port_resolutions is a Map of port to protocol name and component name built in threadServer.js
	// we iterate through the map to build a log for REST and for any components that are using custom ports
	let comps = {};
	let rest_log = `${pad('REST:')}`;
	for (const [key, values] of port_resolutions) {
		for (const value of values) {
			const name = value.name;
			if (name === 'rest') {
				rest_log += `${value.protocol_name}: ${key}, `;
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
	if (rest_log.length > padding + 1) {
		rest_log = rest_log.slice(0, -2);
		log_msg += `${rest_log}\n`;
	}

	let app_ports_log = env.get(CONFIG_PARAMS.HTTP_PORT) ? `HTTP: ${env.get(CONFIG_PARAMS.HTTP_PORT)}, ` : '';
	app_ports_log += env.get(CONFIG_PARAMS.HTTP_SECUREPORT) ? `HTTPS: ${env.get(CONFIG_PARAMS.HTTP_SECUREPORT)}, ` : '';
	if (app_ports_log.length > padding + 1) app_ports_log = app_ports_log.slice(0, -2);

	// Build logs for all components
	for (const c of components) {
		if (comps[c]) {
			log_msg += `${pad(c)}${comps[c].slice(0, -2)}\n`;
		} else {
			log_msg += `${pad(c)}${app_ports_log}\n`;
		}
	}

	console.log(log_msg);
}
