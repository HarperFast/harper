'use strict';

// Note - do not import/use common_utils.js in this module, it will cause circular dependencies.
const fs = require('fs-extra');
const { workerData, threadId } = require('worker_threads');
const path = require('path');
const YAML = require('yaml');
const PropertiesReader = require('properties-reader');
const hdb_terms = require('../hdbTerms');
const assignCMDENVVariables = require('../assignCmdEnvVariables');
const os = require('os');
const { PACKAGE_ROOT } = require('../../utility/hdbTerms');
const native_console_methods = {};
for (let key in console) {
	native_console_methods[key] = console[key];
}
const LOG_LEVEL_HIERARCHY = {
	notify: 7,
	fatal: 6,
	error: 5,
	warn: 4,
	info: 3,
	debug: 2,
	trace: 1,
};

const OUTPUTS = {
	STDOUT: 'stdOut',
	STDERR: 'stdErr',
};

// Install log is created in harperdb/logs because the hdb folder doesn't exist initially during the install process.
const INSTALL_LOG_LOCATION = path.join(PACKAGE_ROOT, `logs`);

// Location of default config YAML.
const DEFAULT_CONFIG_FILE = path.join(PACKAGE_ROOT, 'config/yaml/', hdb_terms.HDB_DEFAULT_CONFIG_FILE);

const CLOSE_LOG_FD_TIMEOUT = 10000;

let log_to_file;
let log_to_stdstreams;
let log_level;
let log_name;
let log_root;
let log_file_path;
let log_fd;

// If this is the first time logger is called by process, hdb props will be undefined.
// Call init to get all the required log settings.
let hdb_properties;
if (hdb_properties === undefined) initLogSettings();

module.exports = {
	notify,
	fatal,
	error,
	warn,
	info,
	debug,
	trace,
	setLogLevel,
	log_level,
	loggerWithTag,
	suppressLogging,
	initLogSettings,
	setupConsoleLogging,
	logCustomLevel,
	getLogFilePath: () => log_file_path,
	OUTPUTS,
};

/**
 * Get the log settings from the settings file.
 * If the settings file doesn't exist (during install) check for command or env vars, if there aren't
 * any, use default values.
 */
function initLogSettings(force_init = false) {
	try {
		if (hdb_properties === undefined || force_init) {
			closeLogFile();
			const boot_props_file_path = getPropsFilePath();
			hdb_properties = PropertiesReader(boot_props_file_path);
			let properties = assignCMDENVVariables(['ROOTPATH']);
			({
				level: log_level,
				config_log_path: log_root,
				to_file: log_to_file,
				to_stream: log_to_stdstreams,
			} = getLogConfig(
				properties.ROOTPATH
					? path.join(properties.ROOTPATH, hdb_terms.HDB_CONFIG_FILE)
					: hdb_properties.get('settings_path')
			));

			log_name = hdb_terms.LOG_NAMES.HDB;
			log_file_path = path.join(log_root, log_name);
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
			log_root = INSTALL_LOG_LOCATION;
			log_name = hdb_terms.LOG_NAMES.INSTALL;
			log_file_path = path.join(log_root, log_name);

			return;
		}

		error('Error initializing log settings');
		error(err);
		throw err;
	}
	setupConsoleLogging();
}
let logging_enabled = true;

function setupConsoleLogging() {
	logConsole('error', error);
	logConsole('warn', warn);
	logConsole('log', info);
	logConsole('info', info);
	logConsole('debug', debug);
	logConsole('trace', trace);
}
function logConsole(level, logger) {
	console[level] = function (...args) {
		if (logging_enabled) logger(...args);
		if (!/PM2 log:|App \[/.test(args[0])) return native_console_methods[level](...args);
	};
}

function loggerWithTag(tag) {
	let tag_object = { tagName: tag.replace(/ /g, '-') }; // tag can't have spaces
	return {
		notify: logWithTag(notify),
		fatal: logWithTag(fatal),
		error: logWithTag(error),
		warn: logWithTag(warn),
		info: logWithTag(info),
		debug: logWithTag(debug),
		trace: logWithTag(trace),
	};
	function logWithTag(logger) {
		return function (...args) {
			return logger(tag_object, ...args);
		};
	}
}

function suppressLogging(callback) {
	try {
		logging_enabled = false;
		callback();
	} finally {
		logging_enabled = true;
	}
}

/**
 * This function iterates given args array to ensure objects are stringified as needed; spaces are added after each arg except for the last one
 * @param {string} level - the logging level
 * @param {[*]} args - the array of arguments that will be converted into a single log line
 * @returns {string} - a complete log
 */

const SERVICE_NAME = workerData?.name?.replace(/ /g, '-') || 'main';
function createLogRecord(level, args) {
	const date_now = new Date(Date.now()).toISOString();

	// If an error instance is stringified it returns an empty object. Also, adding the error instance to a string
	// only logs the error message and not the stack, that is why we need to set message to stack.
	let log_msg = '';
	let length = args.length;
	const last_arg = length - 1;
	let tags = '[' + level + ']';
	let x = 0;
	if (typeof args[0] === 'string' && /\[[\w-]+]/.test(args[0])) {
		tags = tags.slice(0, -1) + ' ' + args[0].slice(1);
		x++;
	}
	let service_name;
	if (typeof args[0] === 'object') {
		if (args[0]?.tagName) {
			tags = tags.slice(0, -1) + ' ' + args[0]?.tagName + ']';
			x++;
		} else if (args[0]?.serviceName) {
			service_name = args[0]?.serviceName;
			x++;
		}
	}
	tags = `[${service_name || SERVICE_NAME + '/' + threadId} ${tags.slice(1)}`;
	for (; x < length; x++) {
		let arg = args[x];
		if (arg instanceof Error && arg.stack) {
			log_msg += arg.stack;
		} else if (typeof arg === 'object') {
			log_msg += JSON.stringify(arg);
		} else {
			log_msg += arg;
		}
		if (x < last_arg) {
			log_msg += ' ';
		}
	}

	return `${date_now}${tags ? ' ' + tags : tags}: ${log_msg}\n`;
}

/**
 * Log to std out and/or file
 * @param log
 */
function logStdOut(log) {
	if (log_to_file) logToFile(log);
	if (log_to_stdstreams) process.stdout.write(log);
}

/**
 * Log to std err and/or file
 * @param log
 */
function logStdErr(log) {
	if (log_to_file) logToFile(log);
	if (log_to_stdstreams) process.stderr.write(log);
}

function logToFile(log) {
	openLogFile();
	fs.appendFileSync(log_fd, log);
}

function closeLogFile() {
	try {
		fs.closeSync(log_fd);
	} catch (err) {}
	log_fd = null;
}

function openLogFile() {
	if (!log_fd) {
		log_fd = fs.openSync(log_file_path, 'a');
		setTimeout(() => {
			closeLogFile();
		}, CLOSE_LOG_FD_TIMEOUT).unref(); // periodically time it out so we can reset it in case the file has been moved (log rotation or by user) or deleted.
	}
}

/**
 * Log an info level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function info(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['info']) {
		logStdOut(createLogRecord('info', args));
	}
}

/**
 * Log a trace level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function trace(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['trace']) {
		logStdOut(createLogRecord('trace', args));
	}
}

/**
 * Log a error level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function error(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['error']) {
		logStdErr(createLogRecord('error', args));
	}
}

/**
 * Log a debug level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function debug(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['debug']) {
		logStdOut(createLogRecord('debug', args));
	}
}

/**
 * Log a notify level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function notify(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['notify']) {
		logStdOut(createLogRecord('notify', args));
	}
}

/**
 * Log a fatal level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function fatal(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['fatal']) {
		logStdErr(createLogRecord('fatal', args));
	}
}

/**
 * Log a warn level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. createLogRecord will do that
 */
function warn(...args) {
	if (LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY['warn']) {
		logStdErr(createLogRecord('warn', args));
	}
}

function logCustomLevel(level, output, ...args) {
	if (output === OUTPUTS.STDERR) logStdErr(createLogRecord(level, args));
	else logStdOut(createLogRecord(level, args));
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
		_boot_props_file_path = path.join(PACKAGE_ROOT, 'utility/hdb_boot_properties.file');
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
 * Reads the harperdb-config.yaml file for log settings.
 * @param hdb_config_path
 * @returns {{config_log_path: any, rotate: any, level: any, to_file: any, root: any, to_stream: any}}
 */
function getLogConfig(hdb_config_path) {
	try {
		// This is here to accommodate pre 4.0.0 settings files that might exist during upgrade.
		if (hdb_config_path.includes('config/settings.js')) {
			const old_hdb_settings = PropertiesReader(hdb_config_path);
			return {
				level: old_hdb_settings.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_LEVEL_KEY),
				config_log_path: path.dirname(old_hdb_settings.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY)),
				to_file: old_hdb_settings.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_TO_FILE),
				to_stream: old_hdb_settings.get(hdb_terms.HDB_SETTINGS_NAMES.LOG_TO_STDSTREAMS),
			};
		}
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
 * Used in early install stages before harperdb-config.yaml exists
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
