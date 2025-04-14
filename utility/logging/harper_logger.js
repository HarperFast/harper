'use strict';

// Note - do not import/use common_utils.js in this module, it will cause circular dependencies.
const fs = require('fs-extra');
const { workerData, threadId, isMainThread } = require('worker_threads');
const path = require('path');
const YAML = require('yaml');
const PropertiesReader = require('properties-reader');
const hdb_terms = require('../hdbTerms');
const assignCMDENVVariables = require('../assignCmdEnvVariables');
const os = require('os');
const { PACKAGE_ROOT } = require('../../utility/packageUtils');
const { _assignPackageExport } = require('../../globals');
const { Console } = require('console');
// store the native write function so we can call it after we write to the log file (and store it on process.stdout
// because unit tests will create multiple instances of this module)
let native_std_write = process.stdout.nativeWrite || (process.stdout.nativeWrite = process.stdout.write);
let fileLoggers = new Map();

const MAX_LOG_BUFFER = 10000;
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

let logConsole;
let log_to_file;
let log_to_stdstreams;
let log_level;
let log_name;
let log_root;
let log_file_path;
let main_logger;
let main_log_fd;
let writeToLogFile;
let logImmediately;

// If this is the first time logger is called by process, hdb props will be undefined.
// Call init to get all the required log settings.
let hdb_properties;

class HarperLogger extends Console {
	constructor(streams, level) {
		streams.stdout.removeListener = () => {};
		streams.stderr.removeListener = () => {};
		streams.stdout.listenerCount = () => {};
		streams.stderr.listenerCount = () => {};
		super(streams);
		this.level = level;
	}
	trace(...args) {
		current_level = 'trace';
		if (this.level <= LOG_LEVEL_HIERARCHY.trace) {
			super.info(...args);
		}
		current_level = 'info';
	}
	debug(...args) {
		current_level = 'debug';
		if (this.level <= LOG_LEVEL_HIERARCHY.debug) {
			super.info(...args);
		}
		current_level = 'info';
	}
	info(...args) {
		current_level = 'info';
		if (this.level <= LOG_LEVEL_HIERARCHY.info) {
			super.info(...args);
		}
		current_level = 'info';
	}
	warn(...args) {
		current_level = 'warn';
		if (this.level <= LOG_LEVEL_HIERARCHY.warn) {
			super.warn(...args);
		}
		current_level = 'info';
	}
	error(...args) {
		current_level = 'error';
		if (this.level <= LOG_LEVEL_HIERARCHY.error) {
			super.error(...args);
		}
		current_level = 'info';
	}
	fatal(...args) {
		logImmediately = true;
		try {
			current_level = 'fatal';
			if (this.level <= LOG_LEVEL_HIERARCHY.fatal) {
				super.error(...args);
			}
			current_level = 'info';
		} finally {
			logImmediately = false;
		}
	}
	notify(...args) {
		logImmediately = true;
		try {
			current_level = 'notify';
			if (this.level <= LOG_LEVEL_HIERARCHY.notify) {
				super.info(...args);
			}
			current_level = 'info';
		} finally {
			logImmediately = false;
		}
	}
	withTag(tag) {
		return loggerWithTag(tag, true, this);
	}
	forComponent(name) {
		// to be replaced
		return this;
	}
}

if (hdb_properties === undefined) initLogSettings();

Object.assign(exports, {
	notify,
	fatal,
	error,
	warn,
	info,
	debug,
	trace,
	log_level,
	loggerWithTag,
	suppressLogging,
	initLogSettings,
	logCustomLevel,
	closeLogFile,
	createLogger,
	logsAtLevel,
	getLogFilePath: () => log_file_path,
	setMainLogger,
	OUTPUTS,
	AuthAuditLog,
});
_assignPackageExport('logger', module.exports);
let logged_fd_err;

/**
 * Check if the current log level is at or below the given level.
 * @param level
 * @return {boolean}
 */
function logsAtLevel(level) {
	return LOG_LEVEL_HIERARCHY[log_level] <= LOG_LEVEL_HIERARCHY[level];
}

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
			let properties = assignCMDENVVariables(['ROOTPATH']);
			try {
				hdb_properties = PropertiesReader(boot_props_file_path);
			} catch (err) {
				// This is here for situations where HDB isn't using a boot file
				if (
					!properties.ROOTPATH ||
					(properties.ROOTPATH && !fs.pathExistsSync(path.join(properties.ROOTPATH, hdb_terms.HDB_CONFIG_FILE)))
				)
					throw err;
			}

			//if root path check for config file, if it exists - all good
			// if root path and no config file just throw err
			let rotation;
			({
				level: log_level,
				config_log_path: log_root,
				to_file: log_to_file,
				logConsole: logConsole,
				rotation: rotation,
				to_stream: log_to_stdstreams,
			} = getLogConfig(
				properties.ROOTPATH
					? path.join(properties.ROOTPATH, hdb_terms.HDB_CONFIG_FILE)
					: hdb_properties.get('settings_path')
			));

			log_name = hdb_terms.LOG_NAMES.HDB;
			log_file_path = path.join(log_root, log_name);

			main_logger = createLogger({
				path: log_file_path,
				level: log_level,
				stdStreams: log_to_stdstreams,
				rotation,
				isMainInstance: true,
			});
			if (isMainThread) {
				try {
					const SegfaultHandler = require('segfault-handler');
					SegfaultHandler.registerHandler(path.join(log_root, 'crash.log'));
				} catch (error) {
					// optional dependency, ok if we can't run it
				}
			}
		}
	} catch (err) {
		hdb_properties = undefined;
		if (
			err.code === hdb_terms.NODE_ERROR_CODES.ENOENT ||
			err.code === hdb_terms.NODE_ERROR_CODES.ERR_INVALID_ARG_TYPE
		) {
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

				if (config_param === hdb_terms.CONFIG_PARAMS.LOGGING_CONSOLE) {
					logConsole = config_param;
				}
			}

			const { default_level } = getDefaultConfig();

			log_to_file = false;
			log_to_stdstreams = true;

			log_level = log_level === undefined ? default_level : log_level;

			main_logger = createLogger({ level: log_level, isMainInstance: true });
			return;
		}

		error('Error initializing log settings');
		error(err);
		throw err;
	}
	if (process.env.DEV_MODE) log_to_stdstreams = true;
	stdioLogging();
}
let logging_enabled = true;
function stdioLogging() {
	if (log_to_file) {
		process.stdout.write = function (data) {
			if (
				typeof data === 'string' && // this is how we identify console output vs redirected output from a worker
				logging_enabled &&
				logConsole
			) {
				data = data.toString();
				if (data[data.length - 1] === '\n') data = data.slice(0, -1);
				writeToLogFile(data);
			}
			return native_std_write.apply(process.stdout, arguments);
		};
		process.stderr.write = function (data) {
			if (
				typeof data === 'string' && // this is how we identify console output vs redirected output from a worker
				logging_enabled &&
				logConsole
			) {
				if (data[data.length - 1] === '\n') data = data.slice(0, -1);
				writeToLogFile(data);
			}
			return native_std_write.apply(process.stderr, arguments);
		};
	}
}

function loggerWithTag(tag, conditional, logger = main_logger) {
	tag = tag.replace(/ /g, '-'); // tag can't have spaces
	return {
		notify: logWithTag(logger.notify, 'notify'),
		fatal: logWithTag(logger.fatal, 'fatal'),
		error: logWithTag(logger.error, 'error'),
		warn: logWithTag(logger.warn, 'warn'),
		info: logWithTag(logger.info, 'info'),
		debug: logWithTag(logger.debug, 'debug'),
		trace: logWithTag(logger.trace, 'trace'),
	};
	function logWithTag(loggerMethod, level) {
		return !conditional || logger.level <= LOG_LEVEL_HIERARCHY[level]
			? function (...args) {
					current_tag = tag;
					try {
						return loggerMethod.call(logger, args);
					} finally {
						current_tag = undefined;
					}
				}
			: null;
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

const SERVICE_NAME = workerData?.name?.replace(/ /g, '-') || 'main';
// these are used to store information about the current service and tag so we can prepend them to the log during
// the writes, without having to pass the information through the Console instance
let current_level = 'info'; // default is info
let current_service_name;
let current_tag;
function createLogger({
	path: log_file_path,
	level: log_level,
	stdStreams: log_to_stdstreams,
	rotation,
	isMainInstance: is_main_instance,
	writeToLog,
	component,
}) {
	if (!log_level) log_level = 'info';
	let level = LOG_LEVEL_HIERARCHY[log_level];
	let logger;
	/**
	 * Log to std out and/or file
	 * @param log
	 */
	function logStdOut(log) {
		if (log_to_file) {
			if (log_to_stdstreams) {
				// eslint-disable-next-line no-control-regex,sonarjs/no-control-regex
				logToFile(log.replace(/\x1b\[[0-9;]*m/g, '')); // remove color codes
				logging_enabled = false;
				try {
					// if we are writing std streams we don't want to double write to the file through the stdio capture
					process.stdout.write(log);
				} finally {
					logging_enabled = true;
				}
			} else {
				logToFile(log);
			}
		} else if (log_to_stdstreams) process.stdout.write(log);
	}

	/**
	 * Log to std err and/or file
	 * @param log
	 */
	function logStdErr(log) {
		if (log_to_file) {
			logToFile(log);
			if (log_to_stdstreams) {
				logging_enabled = false;
				try {
					// if we are writing std streams we don't want to double write to the file through the stdio capture
					process.stderr.write(log);
				} finally {
					logging_enabled = true;
				}
			}
		} else if (log_to_stdstreams) process.stderr.write(log);
	}
	let logToFile = log_file_path && getFileLogger(log_file_path, rotation, is_main_instance);
	function logPrepend(write) {
		return {
			write(log) {
				let tags = [current_level];
				tags.unshift(current_service_name || SERVICE_NAME + '/' + threadId);
				if (current_tag) tags.push(current_tag);
				write(`[${tags.join('] [')}]: ${log}`);
			},
		};
	}
	if (is_main_instance) {
		writeToLogFile = logToFile;
	}
	logger = new HarperLogger(
		is_main_instance || writeToLog || !logToFile
			? {
					stdout: logPrepend(writeToLog ?? logStdOut),
					stderr: logPrepend(writeToLog ?? logStdErr),
					colorMode: log_to_stdstreams ?? false,
				}
			: {
					stdout: logPrepend(logToFile),
					stderr: logPrepend(logToFile),
					colorMode: log_to_stdstreams ?? false,
				},
		level
	);
	logger.path = log_file_path;
	logger.closeLogFile = logToFile?.closeLogFile;
	if (!component) {
		let components = new Map();
		logger.forComponent = function (name) {
			let componentLogger = components.get(name);
			if (!componentLogger) {
				componentLogger = createLogger({
					path: log_file_path,
					level: log_level,
					stdStreams: log_to_stdstreams,
					isMainInstance: is_main_instance,
					rotation,
					writeToLog,
					component: true,
				});
				components.set(name, componentLogger);
			}
			return componentLogger;
		};
	}
	return logger;
}
const LOG_TIME_USAGE_THRESHOLD = 100;
/**
 * Get the file logger for the given path. If it doesn't exist, create it.
 * @param path
 * @param is_main_instance
 * @return {any}
 */
function getFileLogger(path, rotation, is_main_instance) {
	let logger = fileLoggers.get(path);
	let logFD, loggedFDError, logTimer;
	let logBuffer;
	let logTimeUsage = 0;
	if (!logger) {
		logger = logToFile;
		logger.closeLogFile = closeLogFile;
		logger.path = path;
		fileLoggers.set(path, logger);
		if (isMainThread && rotation) {
			setTimeout(() => {
				const logRotator = require('./logRotator');
				try {
					logRotator({
						logger,
						...rotation,
					});
				} catch (error) {
					logger('Error initializing log rotator', error);
				}
			}, 100);
		}
	}
	let logCount = 0;
	return logger;
	function logToFile(log) {
		logCount++;
		let entry = `${new Date().toISOString()} ${log}${log.endsWith('\n') ? '' : '\n'}`;
		if (logBuffer) {
			// if we are currently in log buffer mode, we will add the entry to the buffer (there will be a timer to write it)
			if (logBuffer.length < MAX_LOG_BUFFER) {
				logBuffer.push(entry);
			} else if (logBuffer.length === MAX_LOG_BUFFER) {
				logBuffer.push('Maximum log buffer rate reached, logs will be throttled\n');
			}
			if (logImmediately) {
				clearTimeout(logTimer);
				logQueuedData();
			}
		} else {
			if (logImmediately || logTimeUsage < performance.now() + LOG_TIME_USAGE_THRESHOLD) {
				// if we have a directive to log immediately, or we are not using more than 2 percent of processing time
				logQueuedData(entry);
			} else {
				logTimeUsage = Math.min(logTimeUsage, performance.now() + LOG_TIME_USAGE_THRESHOLD);
				logBuffer = [entry];
				logTimer = setTimeout(logQueuedData, 1);
			}
		}
	}
	// this is called on a timer, and will write the log buffer to the file
	function logQueuedData(entry) {
		openLogFile();
		if (logFD) {
			let startTime = performance.now();
			fs.appendFileSync(logFD, logBuffer ? logBuffer.join('') : entry);
			let endTime = performance.now();
			// determine if we are using more than about two percent of processing time for log writes recently, and if so, we
			// will start buffering
			logTimeUsage = Math.max(endTime, logTimeUsage) + (endTime - startTime) * 50;
		} else if (!loggedFDError) console.log(logBuffer ? logBuffer.join('') : entry);
		if (logBuffer) logBuffer = null;
	}

	function closeLogFile() {
		try {
			fs.closeSync(logFD);
		} catch (err) {}
		logFD = null;
		if (is_main_instance) main_log_fd = null;
	}

	function openLogFile() {
		if (!logFD) {
			try {
				logFD = fs.openSync(path, 'a');
				if (is_main_instance) main_log_fd = logFD;
			} catch (error) {
				if (!loggedFDError) {
					loggedFDError = true;
					console.error(error);
				}
			}
			setTimeout(() => {
				closeLogFile();
			}, CLOSE_LOG_FD_TIMEOUT).unref(); // periodically time it out so we can reset it in case the file has been moved (log rotation or by user) or deleted.
		}
	}
}
/**
 * Log an info level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
function info(...args) {
	main_logger.info(...args);
}

/**
 * Log a trace level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
function trace(...args) {
	main_logger.trace(...args);
}

/**
 * Log a error level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
function error(...args) {
	main_logger.error(...args);
}

/**
 * Log a debug level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
function debug(...args) {
	main_logger.debug(...args);
}

/**
 * Log a notify level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
function notify(...args) {
	main_logger.notify(...args);
}

/**
 * Log a fatal level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
function fatal(...args) {
	main_logger.fatal(...args);
}

/**
 * Log a warn level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
function warn(...args) {
	main_logger.warn(...args);
}

function logCustomLevel(level, output, options, ...args) {
	current_service_name = options.service_name;
	try {
		main_logger[level](...args);
	} finally {
		current_service_name = undefined;
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
		const logConsole = config_doc.getIn(['logging', 'console']);
		const rotation = config_doc.getIn(['logging', 'rotation'])?.toJSON();

		return {
			level,
			config_log_path,
			to_file,
			to_stream,
			logConsole,
			rotation,
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

function setMainLogger(logger) {
	main_logger = logger;
}
function closeLogFile() {
	try {
		fs.closeSync(main_log_fd);
	} catch (err) {}
	main_log_fd = null;
}

function AuthAuditLog(username, status, type, originating_ip, request_method, path) {
	this.username = username;
	this.status = status;
	this.type = type;
	this.originating_ip = originating_ip;
	this.request_method = request_method;
	this.path = path;
}
