'use strict';

// Note - do not import/use commonUtils.js in this module, it will cause circular dependencies.
import fs from 'fs-extra';
import { workerData, threadId, isMainThread } from 'worker_threads';
import pathModule from 'path';
import YAML from 'yaml';
import PropertiesReader from 'properties-reader';
import * as hdbTerms from '../hdbTerms.js';
import assignCMDENVVariables from '../assignCmdEnvVariables.js';
import os from 'os';
import { PACKAGE_ROOT } from '../../utility/packageUtils.js';
import { _assignPackageExport } from '../../globals.js';
import { Console } from 'console';
let _externalLogger: any; // The actual logger instance

// store the native write function so we can call it after we write to the log file (and store it on process.stdout
// because unit tests will create multiple instances of this module)
let nativeStdWrite = process.env.IS_SCRIPTED_SERVICE
	? function () {
			// if this is a child process started by a start/restart
			// command, we can't write to stdout/stderr, we make this a noop
		}
	: (process.stdout as any).nativeWrite || ((process.stdout as any).nativeWrite = process.stdout.write);
let fileLoggers = new Map();
const { join } = pathModule;

const MAX_LOG_BUFFER = 10000;
const LOG_LEVEL_HIERARCHY: Record<string, number> = {
	notify: 7,
	fatal: 6,
	error: 5,
	warn: 4,
	info: 3,
	debug: 2,
	trace: 1,
};

export const OUTPUTS = {
	STDOUT: 'stdOut',
	STDERR: 'stdErr',
};

// Location of default config YAML.
const DEFAULT_CONFIG_FILE = join(PACKAGE_ROOT, 'static', hdbTerms.HDB_DEFAULT_CONFIG_FILE);

const CLOSE_LOG_FD_TIMEOUT = 10000;

let logConsole: boolean;
let log_to_file: boolean;
let logToStdstreams: boolean;
let colorMode: boolean;
let logLevel: string;
let logName: string;
let logRoot: string;
let logFilePath: string;
let mainLogger: any;
let externalLogger: any; // default logger used for the global used by external components
let mainLogFd: number;
let writeToLogFile: (log: string) => void;
let logImmediately: boolean;

// If this is the first time logger is called by process, hdb props will be undefined.
// Call init to get all the required log settings.
let hdbProperties: any;

let rootConfig: any;

function updateLogger(logger: any, logOptions: any, name?: string) {
	logger.rotation = logOptions.rotation;
	let path = logOptions.path;
	if (path) {
		if (!logOptions.root) logOptions.root = pathModule.dirname(path);
	} else if (logOptions.root) {
		path = join(logOptions.root, logName);
	} else {
		path = mainLogger.path;
		if (!logOptions.root) logOptions.root = pathModule.dirname(path);
	}
	if (path) logger.path = path;
	else console.error('No path for logger', logOptions);
	logger.level = LOG_LEVEL_HIERARCHY[logOptions.level] ?? mainLogger?.level ?? LOG_LEVEL_HIERARCHY.info;
	updateConditional(logger);
	logger.logToStdstreams = logOptions.stdStreams ?? false;
	// if there is a configured tag or if a component is logging to default/main log path, use the component name as the tag
	// to differentiate it
	logger.tag = logOptions.tag ?? ((mainLogger.path === logger.path || externalLogger.path === logger.path) && name);
}
// creates a logger where the methods are only defined if they are within the log level.
// Using this conditional logger means that every method call must be optional like log.trace?.('message),
// but there can be performance benefits to using this since it means that the arguments
// do not need to be evaluated at all.
function updateConditional(logger: any) {
	const conditional = logger.conditional ?? (logger.conditional = {});
	conditional.notify = LOG_LEVEL_HIERARCHY.notify >= logger.level ? logger.notify.bind(logger) : undefined;
	conditional.fatal = LOG_LEVEL_HIERARCHY.fatal >= logger.level ? logger.fatal.bind(logger) : undefined;
	conditional.error = LOG_LEVEL_HIERARCHY.error >= logger.level ? logger.error.bind(logger) : undefined;
	conditional.warn = LOG_LEVEL_HIERARCHY.warn >= logger.level ? logger.warn.bind(logger) : undefined;
	conditional.info = LOG_LEVEL_HIERARCHY.info >= logger.level ? logger.info.bind(logger) : undefined;
	conditional.debug = LOG_LEVEL_HIERARCHY.debug >= logger.level ? logger.debug.bind(logger) : undefined;
	conditional.trace = LOG_LEVEL_HIERARCHY.trace >= logger.level ? logger.trace.bind(logger) : undefined;
}
/**
 * Resolve a config path value against rootPath if it is relative.
 */
function resolveLogPath(configPath: string, rootPath: string): string {
	if (!configPath || !rootPath) return configPath;
	if (pathModule.isAbsolute(configPath)) return configPath;
	return pathModule.resolve(rootPath, configPath);
}
async function updateLogSettings() {
	if (!rootConfig) {
		// set up the initial watcher
		rootConfig = new RootConfigWatcher();
		// wait for it to be ready
		await rootConfig.ready;
		// TODO: Any way to differentiate changes that we can and can't handle?
		rootConfig.on('change', updateLogSettings);
	}
	let rootConfigObject = rootConfig.config;
	const logOptions = rootConfigObject.logging ?? {};
	// Resolve relative paths against rootPath from the same config
	const rootPath = rootConfigObject.rootPath;
	if (logOptions.root) {
		logOptions.root = resolveLogPath(logOptions.root, rootPath);
	}
	if (logOptions.rotation?.path) {
		logOptions.rotation.path = resolveLogPath(logOptions.rotation.path, rootPath);
	}
	updateLogger(mainLogger, logOptions);
	logFilePath = mainLogger.path;
	logConsole = logOptions.console ?? false;
	if (logOptions.external) {
		updateLogger(externalLogger, logOptions.external, undefined);
		for (let [name, component] of mainLogger.components) {
			if (!(rootConfigObject[name] && rootConfigObject[name].logging) && component.isExternal)
				updateLogger(component, logOptions.external, name);
		}
	}
	for (const name in rootConfigObject) {
		// we now scan each component to see if it has logging individual configured
		const component = rootConfigObject[name];
		if (component.logging) {
			updateLogger(mainLogger.forComponent(name), component.logging, name);
		} else if (mainLogger.hasComponent(name)) {
			const componentLogger = mainLogger.forComponent(name);
			updateLogger(componentLogger, (componentLogger.isExternal && logOptions.external) ?? logOptions, name);
		}
	}
}

class HarperLogger extends Console {
	level: number;
	constructor(streams: any, level: number) {
		streams.stdout.removeListener = () => {};
		streams.stderr.removeListener = () => {};
		streams.stdout.listenerCount = () => {};
		streams.stderr.listenerCount = () => {};
		super(streams);
		this.level = level;
	}
	trace(...args: any[]) {
		currentLevel = 'trace';
		if (this.level <= LOG_LEVEL_HIERARCHY.trace) {
			super.info(...args);
		}
		currentLevel = 'info';
	}
	debug(...args: any[]) {
		currentLevel = 'debug';
		if (this.level <= LOG_LEVEL_HIERARCHY.debug) {
			super.info(...args);
		}
		currentLevel = 'info';
	}
	info(...args: any[]) {
		currentLevel = 'info';
		if (this.level <= LOG_LEVEL_HIERARCHY.info) {
			super.info(...args);
		}
		currentLevel = 'info';
	}
	warn(...args: any[]) {
		currentLevel = 'warn';
		if (this.level <= LOG_LEVEL_HIERARCHY.warn) {
			super.warn(...args);
		}
		currentLevel = 'info';
	}
	error(...args: any[]) {
		currentLevel = 'error';
		if (this.level <= LOG_LEVEL_HIERARCHY.error) {
			super.error(...args);
		}
		currentLevel = 'info';
	}
	fatal(...args: any[]) {
		logImmediately = true;
		try {
			currentLevel = 'fatal';
			if (this.level <= LOG_LEVEL_HIERARCHY.fatal) {
				super.error(...args);
			}
			currentLevel = 'info';
		} finally {
			logImmediately = false;
		}
	}
	notify(...args: any[]) {
		logImmediately = true;
		try {
			currentLevel = 'notify';
			if (this.level <= LOG_LEVEL_HIERARCHY.notify) {
				super.info(...args);
			}
			currentLevel = 'info';
		} finally {
			logImmediately = false;
		}
	}
	withTag(tag: string): any {
		return loggerWithTag(tag, true, this);
	}
	forComponent(_name: string): any {
		// to be replaced
		return this;
	}
	hasComponent(_name: string): boolean {
		// to be replaced
		return false;
	}
}

if (hdbProperties === undefined) initLogSettings();

export {
	notify,
	fatal,
	error,
	warn,
	info,
	debug,
	trace,
	logLevel,
	loggerWithTag,
	suppressLogging,
	initLogSettings,
	logCustomLevel,
	closeLogFile,
	createLogger,
	logsAtLevel,
	getLogFilePath,
	forComponent,
	setMainLogger,
	setLogLevel,
	AuthAuditLog,
	errorToString,
	disableStdio,
};

function getLogFilePath(): string {
	return logFilePath;
}

function forComponent(name: string, isExternal?: boolean): any {
	return mainLogger.forComponent(name, isExternal);
}

/**
 * We call this if stdio is not functional
 */
function disableStdio() {
	nativeStdWrite = function () {}; // make this a noop
}

externalLogger = {
	notify(...args: any[]) {
		if (_externalLogger) return _externalLogger.notify(...args);
	},
	fatal(...args: any[]) {
		if (_externalLogger) return _externalLogger.fatal(...args);
	},
	error(...args: any[]) {
		if (_externalLogger) return _externalLogger.error(...args);
	},
	warn(...args: any[]) {
		if (_externalLogger) return _externalLogger.warn(...args);
	},
	info(...args: any[]) {
		if (_externalLogger) return _externalLogger.info(...args);
	},
	debug(...args: any[]) {
		if (_externalLogger) return _externalLogger.debug(...args);
	},
	trace(...args: any[]) {
		if (_externalLogger) return _externalLogger.trace(...args);
	},
	withTag(tag: string) {
		if (_externalLogger) return _externalLogger.withTag(tag);
	},
	loggerWithTag(tag: string) {
		if (_externalLogger) return _externalLogger.withTag(tag);
	},
	forComponent(name: string) {
		if (_externalLogger) return _externalLogger.forComponent(name);
	},
	get path() {
		return _externalLogger ? _externalLogger.path : undefined;
	},
	set path(value) {
		if (_externalLogger) _externalLogger.path = value;
	},
	get tag() {
		return _externalLogger ? _externalLogger.tag : undefined;
	},
	set tag(value) {
		if (_externalLogger) _externalLogger.tag = value;
	},
} as any;
export { externalLogger };
_assignPackageExport('logger', externalLogger);

/**
 * Check if the current log level is at or below the given level.
 * @param level
 * @return {boolean}
 */
function logsAtLevel(level: string): boolean {
	return LOG_LEVEL_HIERARCHY[logLevel] <= LOG_LEVEL_HIERARCHY[level];
}

/**
 * Get the log settings from the settings file.
 * If the settings file doesn't exist (during install) check for command or env vars, if there aren't
 * any, use default values.
 */
function initLogSettings(forceInit = false) {
	try {
		if (hdbProperties === undefined || forceInit) {
			closeLogFile();
			const bootPropsFilePath = getPropsFilePath();
			let properties = assignCMDENVVariables(['ROOTPATH']);
			try {
				hdbProperties = PropertiesReader(bootPropsFilePath);
			} catch (err) {
				// This is here for situations where HDB isn't using a boot file
				if (
					!properties.ROOTPATH ||
					(!fs.pathExistsSync(join(properties.ROOTPATH, hdbTerms.HARPER_CONFIG_FILE)) &&
						!fs.pathExistsSync(join(properties.ROOTPATH, hdbTerms.HDB_CONFIG_FILE)))
				)
					throw err;
			}

			//if root path check for config file, if it exists - all good
			// if root path and no config file just throw err
			let configPath;
			if (properties.ROOTPATH) {
				configPath = join(properties.ROOTPATH, hdbTerms.HARPER_CONFIG_FILE);
				if (!fs.pathExistsSync(configPath) && fs.pathExistsSync(join(properties.ROOTPATH, hdbTerms.HDB_CONFIG_FILE)))
					configPath = join(properties.ROOTPATH, hdbTerms.HDB_CONFIG_FILE);
			} else configPath = hdbProperties.get('settings_path');
			let rotation;
			({
				level: logLevel,
				configLogPath: logRoot,
				toFile: log_to_file,
				logConsole,
				colorMode,
				rotation,
				toStream: logToStdstreams,
			} = getLogConfig(configPath));

			logName = hdbTerms.LOG_NAMES.HDB;
			logFilePath = join(logRoot, logName);

			mainLogger = createLogger({
				path: logFilePath,
				level: logLevel,
				stdStreams: logToStdstreams,
				rotation,
				isExternalInstance: false,
				writeToLog: undefined,
				component: undefined,
			});
			// setup the external logger
			_externalLogger = mainLogger.forComponent('external');
			_externalLogger.tag = null; // don't tag by default
			if (isMainThread) {
				try {
					const SegfaultHandler = require('segfault-handler');
					SegfaultHandler.registerHandler(join(logRoot, 'crash.log'));
				} catch {
					// optional dependency, ok if we can't run it
				}
			}
		}
	} catch (err: any) {
		hdbProperties = undefined;
		if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT || err.code === hdbTerms.NODE_ERROR_CODES.ERR_INVALID_ARG_TYPE) {
			// If the env settings haven't been initialized check cmd/env vars for values. If values not found used default.
			const cmdEnvs = assignCMDENVVariables(Object.keys(hdbTerms.CONFIG_PARAM_MAP), true);
			for (const key in cmdEnvs) {
				const configParam = hdbTerms.CONFIG_PARAM_MAP[key];
				if (configParam) configParam.toLowerCase();
				const configValue = cmdEnvs[key];
				if (configParam === hdbTerms.CONFIG_PARAMS.LOGGING_LEVEL) {
					logLevel = configValue;
					continue;
				}

				if (configParam === hdbTerms.CONFIG_PARAMS.LOGGING_CONSOLE) {
					logConsole = configParam;
				}
			}

			const { defaultLevel } = getDefaultConfig();

			log_to_file = false;
			logToStdstreams = true;

			logLevel = logLevel === undefined ? defaultLevel : logLevel;

			mainLogger = createLogger({
				level: logLevel,
				path: undefined,
				stdStreams: undefined,
				rotation: undefined,
				isExternalInstance: undefined,
				writeToLog: undefined,
				component: undefined,
			});
			// setup the external logger
			_externalLogger = mainLogger.forComponent('external');
			_externalLogger.tag = null; // don't tag by default
			return;
		}

		//error('Error initializing log settings');
		//error(err);
		throw err;
	}
	if (process.env.DEV_MODE) logToStdstreams = true;
	stdioLogging();
}
let loggingEnabled = true;
function stdioLogging() {
	if (log_to_file) {
		(process.stdout as any).write = function (data: any) {
			if (
				typeof data === 'string' && // this is how we identify console output vs redirected output from a worker
				loggingEnabled &&
				logConsole
			) {
				data = data.toString();
				if (data[data.length - 1] === '\n') data = data.slice(0, -1);
				writeToLogFile(data);
			}
			return nativeStdWrite.apply(process.stdout, arguments);
		};
		(process.stderr as any).write = function (data: any) {
			if (
				typeof data === 'string' && // this is how we identify console output vs redirected output from a worker
				loggingEnabled &&
				logConsole
			) {
				if (data[data.length - 1] === '\n') data = data.slice(0, -1);
				writeToLogFile(data);
			}
			return nativeStdWrite.apply(process.stderr, arguments);
		};
	}
}

function loggerWithTag(tag: string, conditional: boolean, logger = mainLogger): any {
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
	function logWithTag(loggerMethod: any, level: string) {
		return !conditional || logger.level <= LOG_LEVEL_HIERARCHY[level]
			? function (...args: any[]) {
					currentTag = tag;
					try {
						return loggerMethod.call(logger, ...args);
					} finally {
						currentTag = undefined;
					}
				}
			: null;
	}
}

function suppressLogging(callback: () => void) {
	try {
		loggingEnabled = false;
		callback();
	} finally {
		loggingEnabled = true;
	}
}

const SERVICE_NAME = workerData?.name?.replace(/ /g, '-') || 'main';
// these are used to store information about the current service and tag so we can prepend them to the log during
// the writes, without having to pass the information through the Console instance
let currentLevel = 'info'; // default is info
let currentServiceName: string;
let currentTag: string | undefined;
function createLogger({
	path: logFilePath,
	level: logLevel,
	stdStreams: logToStdstreams,
	rotation,
	isExternalInstance,
	writeToLog,
	component,
}: {
	path: string | undefined;
	level: string;
	stdStreams: boolean | undefined;
	rotation: any;
	isExternalInstance: boolean | undefined;
	writeToLog: any;
	component: boolean | undefined;
}): any {
	if (!logLevel) logLevel = 'info';
	let level = typeof logLevel === 'number' ? logLevel : LOG_LEVEL_HIERARCHY[logLevel];
	let logger: any;
	/**
	 * Log to std out and/or file
	 * @param log
	 */
	function logStdOut(log: string) {
		if (log_to_file) {
			if (logger.logToStdstreams) {
				// eslint-disable-next-line no-control-regex
				logToFile(log.replace(/\x1b\[[0-9;]*m/g, '')); // remove color codes
				loggingEnabled = false;
				try {
					// if we are writing std streams we don't want to double write to the file through the stdio capture
					process.stdout.write(log);
				} finally {
					loggingEnabled = true;
				}
			} else {
				logToFile(log);
			}
		} else if (logToStdstreams) process.stdout.write(log);
	}

	/**
	 * Log to std err and/or file
	 * @param log
	 */
	function logStdErr(log: string) {
		if (log_to_file) {
			logToFile(log);
			if (logToStdstreams) {
				loggingEnabled = false;
				try {
					// if we are writing std streams we don't want to double write to the file through the stdio capture
					process.stderr.write(log);
				} finally {
					loggingEnabled = true;
				}
			}
		} else if (logToStdstreams) process.stderr.write(log);
	}
	let logToFile = logFilePath && getFileLogger(logFilePath, rotation, isExternalInstance);
	function logPrepend(write: (log: string) => void) {
		return {
			write(log: string) {
				let tags = [currentLevel];
				tags.unshift(currentServiceName || SERVICE_NAME + '/' + threadId);
				if (currentTag) tags.push(currentTag);
				if (logger.tag) tags.push(logger.tag);
				write(`[${tags.join('] [')}]: ${log}`);
			},
		};
	}
	if (isExternalInstance) {
		writeToLogFile = logToFile;
	}
	logger = new HarperLogger(
		{
			stdout: logPrepend(writeToLog ?? logStdOut),
			stderr: logPrepend(writeToLog ?? logStdErr),
			colorMode: (logToStdstreams && colorMode) || false,
		},
		level
	);
	updateConditional(logger);
	logger.path = logFilePath;
	Object.defineProperty(logger, 'path', {
		get() {
			return logFilePath;
		},
		set(path) {
			logFilePath = path;
			logToFile = getFileLogger(logFilePath, logger.rotation, isExternalInstance);
			if (isExternalInstance) writeToLogFile = logToFile;
		},
		enumerable: true,
	});
	logger.closeLogFile = logToFile?.closeLogFile;
	logger.logToStdstreams = logToStdstreams;
	if (!component) {
		let components = new Map();
		logger.forComponent = function (name: string, isExternal = false) {
			let componentLogger = components.get(name);
			if (!componentLogger) {
				const protoLogger = isExternal ? externalLogger : logger;
				componentLogger = createLogger({
					path: protoLogger.path,
					level: protoLogger.level,
					stdStreams: protoLogger.logToStdstreams,
					isExternalInstance: isExternal || name === 'external',
					rotation: protoLogger.rotation,
					writeToLog,
					component: true,
				});
				componentLogger.tag = name;
				components.set(name, componentLogger);
			}
			if (isExternal) componentLogger.isExternal = true;
			return componentLogger;
		};
		logger.hasComponent = function (name: string) {
			return components.has(name);
		};
		logger.components = components;
	}
	return logger;
}
const LOG_TIME_USAGE_THRESHOLD = 100;
/**
 * Get the file logger for the given path. If it doesn't exist, create it.
 * @param path
 * @param isExternalInstance
 * @return {any}
 */
function getFileLogger(path: string, rotation: any, isExternalInstance: boolean | undefined): any {
	let logger = fileLoggers.get(path);
	let logFD: number, loggedFDError: boolean, logTimer: NodeJS.Timeout;
	let logBuffer: string[];
	let logTimeUsage = 0;
	if (!logger) {
		logger = logToFile;
		logger.closeLogFile = closeLogFile;
		logger.path = path;
		fileLoggers.set(path, logger);
	}
	if (isMainThread && JSON.stringify(rotation) !== JSON.stringify(logger.rotation)) {
		logger.rotation = rotation;
		setTimeout(async () => {
			logger.rotator?.end();
			if (!rotation) return;
			const logRotator = require('./logRotator.js');
			try {
				logger.rotator = logRotator({
					logger,
					...rotation,
				});
			} catch (error) {
				logger('Error initializing log rotator', error);
			}
		}, 100);
	}
	return logger;
	function logToFile(log: string) {
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
				logQueuedData(undefined);
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
	function logQueuedData(entry: string | undefined) {
		openLogFile(false);
		if (logFD) {
			let startTime = performance.now();
			fs.appendFileSync(logFD, logBuffer ? logBuffer.join('') : (entry as string));
			let endTime = performance.now();
			// determine if we are using more than about two percent of processing time for log writes recently, and if so, we
			// will start buffering
			logTimeUsage = Math.max(endTime, logTimeUsage) + (endTime - startTime) * 50;
		} else if (!loggedFDError) console.log(logBuffer ? logBuffer.join('') : entry);
		if (logBuffer) logBuffer = [];
	}

	function closeLogFile() {
		try {
			fs.closeSync(logFD);
		} catch {}
		logFD = 0;
		if (isExternalInstance) mainLogFd = 0;
	}

	function openLogFile(isRetry: boolean) {
		if (!logFD) {
			try {
				logFD = fs.openSync(path, 'a');
				if (isExternalInstance) mainLogFd = logFD;
			} catch (error: any) {
				if (error.code === 'ENOENT' && !isRetry) {
					// if the directory doesn't exist, create it
					fs.mkdirpSync(pathModule.dirname(path));
					return openLogFile(true);
				}
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
function info(...args: any[]) {
	mainLogger.info(...args);
}

/**
 * Log a trace level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
function trace(...args: any[]) {
	mainLogger.trace(...args);
}

/**
 * Log a error level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
function error(...args: any[]) {
	mainLogger.error(...args);
}

/**
 * Log a debug level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
function debug(...args: any[]) {
	mainLogger.debug(...args);
}

/**
 * Log a notify level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
function notify(...args: any[]) {
	mainLogger.notify(...args);
}

/**
 * Log a fatal level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
function fatal(...args: any[]) {
	mainLogger.fatal(...args);
}

/**
 * Log a warn level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
function warn(...args: any[]) {
	mainLogger.warn(...args);
}

function logCustomLevel(level: string, output: any, options: any, ...args: any[]) {
	currentServiceName = options.service_name;
	try {
		mainLogger[level](...args);
	} finally {
		currentServiceName = '';
	}
}

/**
 * This is a duplicate of commonUtils.getPropsFilePath.  We need to have it duplicated here to avoid a circular dependency
 * that happens when commonUtils is imported.
 * @returns {*}
 */
function getPropsFilePath(): string {
	let homeDir = undefined;
	try {
		homeDir = os.homedir();
	} catch {
		// could get here in android
		homeDir = process.env.HOME;
	}
	if (!homeDir) {
		homeDir = '~/';
	}

	let _bootPropsFilePath = join(homeDir, hdbTerms.HDB_HOME_DIR_NAME, hdbTerms.BOOT_PROPS_FILE_NAME);
	// this checks how we used to store the boot props file for older installations.
	if (!fs.existsSync(_bootPropsFilePath)) {
		_bootPropsFilePath = join(PACKAGE_ROOT, 'utility/hdb_boot_properties.file');
	}
	return _bootPropsFilePath;
}

function setLogLevel(level: string) {
	logLevel = level;
}

/**
 * Reads the harperdb-config.yaml file for log settings.
 * @param hdbConfigPath
 * @returns {{configLogPath: any, rotate: any, level: any, toFile: any, root: any, toStream: any}}
 */
function getLogConfig(hdbConfigPath: string): any {
	try {
		// This is here to accommodate pre 4.0.0 settings files that might exist during upgrade.
		if (hdbConfigPath.includes('config/settings.js')) {
			const oldHdbSettings = PropertiesReader(hdbConfigPath);
			return {
				level: oldHdbSettings.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_LEVEL_KEY),
				configLogPath: pathModule.dirname(oldHdbSettings.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY) as string),
				toFile: oldHdbSettings.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_TO_FILE),
				toStream: oldHdbSettings.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_TO_STDSTREAMS),
			};
		}
		const configDoc = YAML.parseDocument(fs.readFileSync(hdbConfigPath, 'utf8'));
		const rootPath = configDoc.getIn(['rootPath']);
		const level = configDoc.getIn(['logging', 'level']);
		const configLogPath = resolveLogPath(configDoc.getIn(['logging', 'root']), rootPath);
		const toFile = configDoc.getIn(['logging', 'file']);
		const toStream = configDoc.getIn(['logging', 'stdStreams']);
		const logConsole = configDoc.getIn(['logging', 'console']);
		const colorMode = configDoc.getIn(['logging', 'colors']) ?? true; // default to true
		const rotation = configDoc.getIn(['logging', 'rotation'])?.toJSON();
		// Resolve rotation path if relative
		if (rotation?.path) {
			rotation.path = resolveLogPath(rotation.path, rootPath);
		}

		return {
			level,
			configLogPath,
			toFile,
			toStream,
			logConsole,
			colorMode,
			rotation,
		};
	} catch (err: any) {
		// If the config file doesn't exist throw ENOENT error and parent function will use default log settings
		if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT) {
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
function getDefaultConfig(): any {
	try {
		const defaultConfigDoc = YAML.parseDocument(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8'));
		const defaultLevel = defaultConfigDoc.getIn(['logging', 'level']);
		const defaultToFile = defaultConfigDoc.getIn(['logging', 'file']);
		const defaultToStream = defaultConfigDoc.getIn(['logging', 'stdStreams']);
		return {
			defaultLevel,
			defaultToFile,
			defaultToStream,
		};
	} catch (err) {
		console.error('Error accessing default config file for logging');
		console.error(err);
	}
}

/**
 * This converts an error to a human readable string. This follows the convention of standard console logging
 * of printing the error as "ErrorClassName: message". Strangely, this is _not_ how Error.prototype.toString
 * behaves, so this normalizes to match the bevahior of the console rather than default toString.
 * @param error
 * @return {string|string}
 */
function errorToString(error: Error): string {
	return typeof error.message === 'string' ? `${error.constructor.name}: ${error.message}` : error.toString();
}

function setMainLogger(logger: any) {
	mainLogger = logger;
}
function closeLogFile() {
	try {
		fs.closeSync(mainLogFd);
	} catch {}
	mainLogFd = 0;
}

export class AuthAuditLog {
	username: string;
	status: string;
	type: string;
	originating_ip: string;
	request_method: string;
	path: string;
	constructor(
		username: string,
		status: string,
		type: string,
		originatingIp: string,
		requestMethod: string,
		path: string
	) {
		this.username = username;
		this.status = status;
		this.type = type;
		this.originating_ip = originatingIp;
		this.request_method = requestMethod;
		this.path = path;
	}
}

// we have to load this at the end to avoid circular dependencies problems
const { RootConfigWatcher } = require('../../config/RootConfigWatcher.js');
