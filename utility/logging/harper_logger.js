'use strict';

// Note - do not import/use common_utils.js in this module, it will cause circular dependencies.
const fs = require('fs-extra');
const path = require('path');
const YAML = require('yaml');
const PropertiesReader = require('properties-reader');
const hdb_terms = require('../hdbTerms');
const assignCMDENVVariables = require('../assignCmdEnvVariables');
const os = require('os');

const LOG_LEVEL_HIERARCHY = {
	notify: 7,
	fatal: 6,
	error: 5,
	warn: 4,
	info: 3,
	debug: 2,
	trace: 1,
};

// Install log is created in harperdb/logs because the hdb folder doesn't exist initially during the install process.
const INSTALL_LOG_LOCATION = path.resolve(__dirname, `../../logs`);

// If harper_logger is called by a non-pm2 managed process it will not have a pm id.
const NON_PM2_PROCESS = process.env.pm_id === undefined;

// Location of default config YAML.
const DEFAULT_CONFIG_FILE = path.resolve(__dirname, '../../config/yaml/', hdb_terms.HDB_DEFAULT_CONFIG_FILE);

let process_name =
	process.env.PROCESS_NAME === undefined ? hdb_terms.PROCESS_DESCRIPTORS.INSTALL : process.env.PROCESS_NAME;
let log_stream;
let log_to_file;
let log_to_stdstreams;
let log_level;
let log_path;

// If this is the first time logger is called by process, hdb props will be undefined.
// Call init to get all the required log settings.
let hdb_properties;
if (hdb_properties === undefined) initLogSettings();

module.exports = {
	createLogFile,
	notify,
	fatal,
	error,
	warn,
	info,
	debug,
	trace,
	setLogLevel,
	log_level,
};

/**
 * Get the log settings from the settings file.
 * If the settings file doesn't exist (during install) check for command or env vars, if there aren't
 * any, use default values.
 */
function initLogSettings() {
	try {
		if (hdb_properties === undefined) {
			const boot_props_file_path = getPropsFilePath();
			hdb_properties = PropertiesReader(boot_props_file_path);
			({
				level: log_level,
				config_log_path: log_path,
				to_file: log_to_file,
				to_stream: log_to_stdstreams,
			} = getLogConfig(hdb_properties.get('settings_path')));
		}
	} catch (err) {
		hdb_properties = undefined;
		if (err.code === hdb_terms.NODE_ERROR_CODES.ENOENT) {
			// If the env settings haven't been initialized check cmd/env vars for values. If values not found used default.
			const cmd_envs = assignCMDENVVariables(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
			for (const key in cmd_envs) {
				const config_param = hdb_terms.CONFIG_PARAM_MAP[key];
				if (config_param) config_param.toLowerCase();
				const config_value = cmd_envs[key];
				if (config_param === hdb_terms.CONFIG_PARAMS.LOGGING_LEVEL) {
					log_level = config_value;
					continue;
				}

				if (config_param === hdb_terms.CONFIG_PARAMS.LOGGING_STDSTREAMS) {
					log_to_stdstreams = config_value;
					continue;
				}

				if (config_param === hdb_terms.CONFIG_PARAMS.LOGGING_FILE) {
					log_to_file = config_param;
				}
			}

			const { default_level, default_to_file, default_to_stream } = getDefaultConfig();

			log_to_file = log_to_file === undefined ? default_to_file : log_to_file;
			log_to_file = autoCastBoolean(log_to_file);

			log_to_stdstreams = log_to_stdstreams === undefined ? default_to_stream : log_to_stdstreams;
			log_to_stdstreams = autoCastBoolean(log_to_stdstreams);

			log_level = log_level === undefined ? default_level : log_level;

			// If env hasn't been initialized process is likely install.
			log_path = INSTALL_LOG_LOCATION;

			return;
		}

		error('Error initializing log settings');
		error(err);
		throw err;
	}
}

/**
 * If a process is not run by pm2 (like the bin modules) create a log file/stream.
 * @param log_name
 * @param log_process_name
 */
function createLogFile(log_name, log_process_name) {
	if (!NON_PM2_PROCESS) {
		error('createLogFile should only be used if the process is not being managed by pm2');
		return;
	}

	if (hdb_properties === undefined) initLogSettings();
	process_name = log_process_name;
	let log_dir;
	if (log_name === hdb_terms.PROCESS_LOG_NAMES.INSTALL) {
		log_dir = INSTALL_LOG_LOCATION;
	} else {
		log_dir = log_path;
	}

	if (log_to_file) {
		log_stream = fs.createWriteStream(path.join(log_dir, log_name), {
			autoClose: true,
			flags: 'a',
		});

		log_stream.on('error', (err) => {
			console.error(err);
		});
	}
}

/**
 * This function iterates given args array to ensure objects are stringified as needed; spaces are added after each arg except for the last one
 * @param {string} level - the logging level
 * @param {[*]} args - the array of arguments that will be converted into a single log line
 * @returns {string} - a complete log
 */

function createLogRecord(level, args) {
	const date_now = new Date(Date.now()).toISOString();

	// If an error instance is stringified it returns an empty object. Also, adding the error instance to a string
	// only logs the error message and not the stack, that is why we need to set message to stack.
	let log_msg = '';
	let length = args.length;
	const last_arg = length - 1;
	for (let x = 0; x < length; x++) {
		let arg = args[x];
		if (arg instanceof Error && arg.stack) {
			log_msg = arg.stack;
		} else if (typeof arg === 'object') {
			log_msg += JSON.stringify(arg);
		} else {
			log_msg += arg;
		}
		if (x < last_arg) {
			log_msg += ' ';
		}
	}
	return `{"process_name": "${process_name}", "level": "${level}", "timestamp": "${date_now}", "message": "${log_msg}"}\n`;
}

/**
 * If the stream doesn't exist, write to the install log. The only time the log stream should be undefined is initially
 * during install or before any of the bin modules have had a chance to create their own log.
 * @param log
 */
function writeToLogStream(log) {
	if (log_stream === undefined) {
		process_name = hdb_terms.PROCESS_DESCRIPTORS.INSTALL;
		fs.ensureDirSync(INSTALL_LOG_LOCATION);
		log_stream = fs.createWriteStream(path.join(INSTALL_LOG_LOCATION, hdb_terms.PROCESS_LOG_NAMES.INSTALL), {
			autoClose: true,
			flags: 'a',
		});

		log_stream.on('error', (err) => {
			console.error(err);
		});
	}

	log_stream.write(log);
}

/**
 * Determine if non-pm2 managed log should go to std out and/or file
 * @param log
 */
function nonPm2LogStdOut(log) {
	if (log_to_file) writeToLogStream(log);
	if (log_to_stdstreams) process.stdout.write(log);
}

/**
 * Determine if non-pm2 managed log should go to std err and/or file
 * @param log
 */
function nonPm2LogStdErr(log) {
	if (log_to_file) writeToLogStream(log);
	if (log_to_stdstreams) process.stderr.write(log);
}

/**
 * Log a info level log.
 * @param {[*]} args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function info(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['info']) {
		const log = createLogRecord('info', args);
		if (NON_PM2_PROCESS) {
			nonPm2LogStdOut(log);
			return;
		}

		process.stdout.write(log);
	}
}

/**
 * Log a trace level log.
 * @param {[*]} args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function trace(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['trace']) {
		const log = createLogRecord('trace', args);
		if (NON_PM2_PROCESS) {
			nonPm2LogStdOut(log);
			return;
		}

		process.stdout.write(log);
	}
}

/**
 * Log a error level log.
 * @param {[*]} args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function error(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['error']) {
		const log = createLogRecord('error', args);
		if (NON_PM2_PROCESS) {
			nonPm2LogStdErr(log);
			return;
		}

		process.stderr.write(log);
	}
}

/**
 * Log a debug level log.
 * @param {[*]} args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function debug(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['debug']) {
		const log = createLogRecord('debug', args);
		if (NON_PM2_PROCESS) {
			nonPm2LogStdOut(log);
			return;
		}

		process.stdout.write(log);
	}
}

/**
 * Log a notify level log.
 * @param {[*]} args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function notify(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['notify']) {
		const log = createLogRecord('notify', args);
		if (NON_PM2_PROCESS) {
			nonPm2LogStdOut(log);
			return;
		}

		process.stdout.write(log);
	}
}

/**
 * Log a fatal level log.
 * @param {[*]} args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function fatal(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['fatal']) {
		const log = createLogRecord('fatal', args);
		if (NON_PM2_PROCESS) {
			nonPm2LogStdErr(log);
			return;
		}

		process.stderr.write(log);
	}
}

/**
 * Log a warn level log.
 * @param {[*]} args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function warn(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['warn']) {
		const log = createLogRecord('warn', args);
		if (NON_PM2_PROCESS) {
			nonPm2LogStdErr(log);
			return;
		}

		process.stderr.write(log);
	}
}

/**
 * This is a duplicate of common_utils.getPropsFilePath.  We need to have it duplicated here to avoid a circular dependency
 * that happens when common_utils is imported.
 * @returns {*}
 */
function getPropsFilePath() {
	let home_dir = undefined;
	try {
		home_dir = os.homedir();
	} catch (err) {
		// could get here in android
		home_dir = process.env.HOME;
	}
	if (!home_dir) {
		home_dir = '~/';
	}

	let _boot_props_file_path = path.join(home_dir, hdb_terms.HDB_HOME_DIR_NAME, hdb_terms.BOOT_PROPS_FILE_NAME);
	// this checks how we used to store the boot props file for older installations.
	if (!fs.existsSync(_boot_props_file_path)) {
		_boot_props_file_path = path.join(__dirname, '../', 'hdb_boot_properties.file');
	}
	return _boot_props_file_path;
}

function setLogLevel(level) {
	log_level = level;
}

/**
 * Takes a boolean string/value and casts it to a boolean
 * @param boolean
 * @returns {boolean}
 */
function autoCastBoolean(boolean) {
	return boolean === true || (typeof boolean === 'string' && boolean.toLowerCase() === 'true');
}

/**
 * Reads the harperdb.conf file for log settings.
 * @param hdb_config_path
 * @returns {{config_log_path: any, rotate: any, level: any, to_file: any, root: any, to_stream: any}}
 */
function getLogConfig(hdb_config_path) {
	try {
		const config_doc = YAML.parseDocument(fs.readFileSync(hdb_config_path, 'utf8'));
		const level = config_doc.getIn(['logging', 'level']);
		const config_log_path = config_doc.getIn(['logging', 'root']);
		const to_file = config_doc.getIn(['logging', 'file']);
		const to_stream = config_doc.getIn(['logging', 'stdStreams']);
		return {
			level,
			config_log_path,
			to_file,
			to_stream,
		};
	} catch (err) {
		// If the config file doesn't exist throw ENOENT error and parent function will use default log settings
		if (err.code === hdb_terms.NODE_ERROR_CODES.ENOENT) {
			throw err;
		}

		console.error('Error accessing config file for logging');
		console.error(err);
	}
}

/**
 * Read the default harperdb yaml file for default log settings.
 * Used in early install stages before harperdb.conf exists
 * @returns {{default_to_file: any, default_level: any, default_to_stream: any}}
 */
function getDefaultConfig() {
	try {
		const default_config_doc = YAML.parseDocument(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8'));
		const default_level = default_config_doc.getIn(['logging', 'level']);
		const default_to_file = default_config_doc.getIn(['logging', 'file']);
		const default_to_stream = default_config_doc.getIn(['logging', 'stdStreams']);
		return {
			default_level,
			default_to_file,
			default_to_stream,
		};
	} catch (err) {
		console.error('Error accessing default config file for logging');
		console.error(err);
	}
}
