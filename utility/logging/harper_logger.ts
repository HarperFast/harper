'use strict';

// Note - do not import/use commonUtils.js in this module, it will cause circular dependencies.
import * as fs from 'fs-extra';
import { workerData, threadId, isMainThread } from 'worker_threads';
import * as pathModule from 'path';
import * as YAML from 'yaml';
const PropertiesReader = require('properties-reader');
import * as hdbTerms from '../hdbTerms.ts';
import assignCMDENVVariables from '../assignCmdEnvVariables.ts';
import * as os from 'os';
import { PACKAGE_ROOT } from '../../utility/packageUtils.js';
import { _assignPackageExport } from '../../globals.js';
import { Console } from 'console';
import { inspect, types } from 'node:util';

const { isNativeError } = types;
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
const LOG_LEVEL_HIERARCHY = {
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

let logConsole;
let log_to_file;
let logToStdstreams;
let colorMode;
export let logLevel: any;
let logName;
let logRoot;
let logFilePath;
let mainLogger;
export let externalLogger: any = {
	notify(...args) {
		externalLogger.notify(...args);
	},
	fatal(...args) {
		externalLogger.fatal(...args);
	},
	error(...args) {
		externalLogger.error(...args);
	},
	warn(...args) {
		externalLogger.warn(...args);
	},
	info(...args) {
		externalLogger.info(...args);
	},
	debug(...args) {
		externalLogger.debug(...args);
	},
	trace(...args) {
		externalLogger.trace(...args);
	},
	withTag(tag) {
		return externalLogger.withTag(tag);
	},
	loggerWithTag(tag) {
		return externalLogger.withTag(tag);
	},
	forComponent(name: string) {
		return externalLogger.forComponent(name);
	},
};
_assignPackageExport('logger', externalLogger);
// default logger used for the global used by external components
let mainLogFd;
let writeToLogFile;
let logImmediately;

// If this is the first time logger is called by process, hdb props will be undefined.
// Call init to get all the required log settings.
let hdbProperties;

let rootConfig;

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
function resolveLogPath(configPath: string, rootPath: string) {
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
		updateLogger(externalLogger, logOptions.external);
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

/**
 * True when the argument is an Error (same-realm or native cross-realm — component code runs
 * through node:vm, so a VM-created Error fails `instanceof Error` but passes `isNativeError`).
 * The try/catch guards exotic objects whose prototype is unreachable (e.g. a revoked Proxy,
 * where `instanceof` throws) — the logger must never throw on any input, and util.format
 * renders those fine raw. Exported so call sites outside this module (e.g.
 * OperationFunctionCaller, deciding how to log an error-shaped value it didn't itself catch as
 * an Error) can reuse the same classification instead of a weaker local `instanceof` check.
 */
export function isErrorLike(arg: any): boolean {
	try {
		return arg instanceof Error || isNativeError(arg);
	} catch {
		return false;
	}
}

/**
 * Replaces every Error argument with its log-safe errorForLog wrapper before the args reach
 * Console's util.inspect formatting, which would otherwise dump the error's own-enumerable
 * properties — where libraries and app code stash credentials (axios config headers, an
 * hdb_secret for an outbound Authorization header) — into hdb.log (see #1734 and errorForLog).
 * Called inside each level gate so filtered-out log calls pay nothing beyond the arg scan,
 * and only allocates when an Error is actually present. Deliberately shallow: an Error nested
 * inside a logged object/array is not rewritten (deep-walking every logged structure is not
 * worth the per-call cost, and the #1734 threat is raw thrown errors).
 */
function sanitizeErrorArgs(args: any[]) {
	for (let i = 0; i < args.length; i++) {
		if (isErrorLike(args[i])) {
			const sanitized = args.slice(0, i);
			for (let j = i; j < args.length; j++) {
				const arg = args[j];
				sanitized[j] = isErrorLike(arg) ? errorForLog(arg) : arg;
			}
			return sanitized;
		}
	}
	return args;
}

class HarperLogger extends Console {
	[key: string]: any;
	constructor(streams, level) {
		streams.stdout.removeListener = () => {};
		streams.stderr.removeListener = () => {};
		streams.stdout.listenerCount = () => {};
		streams.stderr.listenerCount = () => {};
		super(streams);
		this.level = level;
	}
	trace(...args) {
		currentLevel = 'trace';
		if (this.level <= LOG_LEVEL_HIERARCHY.trace) {
			super.info(...sanitizeErrorArgs(args));
		}
		currentLevel = 'info';
	}
	debug(...args) {
		currentLevel = 'debug';
		if (this.level <= LOG_LEVEL_HIERARCHY.debug) {
			super.info(...sanitizeErrorArgs(args));
		}
		currentLevel = 'info';
	}
	info(...args) {
		currentLevel = 'info';
		if (this.level <= LOG_LEVEL_HIERARCHY.info) {
			super.info(...sanitizeErrorArgs(args));
		}
		currentLevel = 'info';
	}
	warn(...args) {
		currentLevel = 'warn';
		if (this.level <= LOG_LEVEL_HIERARCHY.warn) {
			super.warn(...sanitizeErrorArgs(args));
		}
		currentLevel = 'info';
	}
	error(...args) {
		currentLevel = 'error';
		if (this.level <= LOG_LEVEL_HIERARCHY.error) {
			super.error(...sanitizeErrorArgs(args));
		}
		currentLevel = 'info';
	}
	fatal(...args) {
		logImmediately = true;
		try {
			currentLevel = 'fatal';
			if (this.level <= LOG_LEVEL_HIERARCHY.fatal) {
				super.error(...sanitizeErrorArgs(args));
			}
			currentLevel = 'info';
		} finally {
			logImmediately = false;
		}
	}
	notify(...args) {
		logImmediately = true;
		try {
			currentLevel = 'notify';
			if (this.level <= LOG_LEVEL_HIERARCHY.notify) {
				super.info(...sanitizeErrorArgs(args));
			}
			currentLevel = 'info';
		} finally {
			logImmediately = false;
		}
	}
	// Inherited Console methods that format arbitrary values would bypass sanitizeErrorArgs —
	// guard them too so logger.log(error) / dir / table can't leak either (#1734). Their
	// existing semantics (no level gate) are preserved; only the Error args are wrapped.
	log(...args) {
		super.log(...sanitizeErrorArgs(args));
	}
	dir(item, options?) {
		super.dir(isErrorLike(item) ? errorForLog(item) : item, options);
	}
	table(data, columns?) {
		super.table(Array.isArray(data) ? sanitizeErrorArgs(data) : isErrorLike(data) ? errorForLog(data) : data, columns);
	}
	withTag(tag) {
		return loggerWithTag(tag, true, this);
	}
	forComponent(_name) {
		// to be replaced
		return this;
	}
	hasComponent(_name) {
		// to be replaced
		return false;
	}
}

if (hdbProperties === undefined) initLogSettings();

module.exports = {
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
	getLogFilePath: () => logFilePath,
	forComponent: (name, isExternal) => mainLogger.forComponent(name, isExternal),
	setMainLogger,
	setLogLevel,
	OUTPUTS,
	AuthAuditLog,
	// for now these functions at least notify us of when the component system is ready so
	// we can start using the RootConfigWatcher
	start: updateLogSettings,
	startOnMainThread: updateLogSettings,
	errorToString,
	errorForLog,
	inspectForLog,
	isErrorLike,
	disableStdio,
	externalLogger,
};

/**
 * We call this if stdio is not functional
 */
export function disableStdio(_unused?: any) {
	nativeStdWrite = function () {}; // make this a noop
}

/**
 * Check if the current log level is at or below the given level.
 * @param level
 * @return {boolean}
 */
export function logsAtLevel(level: any) {
	return LOG_LEVEL_HIERARCHY[logLevel] <= LOG_LEVEL_HIERARCHY[level];
}

/**
 * Get the log settings from the settings file.
 * If the settings file doesn't exist (during install) check for command or env vars, if there aren't
 * any, use default values.
 */
export function initLogSettings(forceInit = false) {
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
			});
			// setup the external logger
			externalLogger = mainLogger.forComponent('external');
			externalLogger.tag = null; // don't tag by default
			if (isMainThread && typeof globalThis.Bun === 'undefined') {
				// Bun will crash with the segfault handler, ironically
				try {
					const SegfaultHandler = require('segfault-handler');
					SegfaultHandler.registerHandler(join(logRoot, 'crash.log'));
				} catch {
					// optional dependency, ok if we can't run it
				}
			}
		}
	} catch (err) {
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

			mainLogger = createLogger({ level: logLevel });
			// setup the external logger
			externalLogger = mainLogger.forComponent('external');
			externalLogger.tag = null; // don't tag by default
			return;
		}

		console.error(err);

		if (mainLogger) error('Error initializing log settings');
		else console.error('Error initializing log settings');
		if (mainLogger) error(err);

		throw err;
	}
	if (process.env.DEV_MODE) logToStdstreams = true;
	stdioLogging();
}
let loggingEnabled = true;
function stdioLogging() {
	if (log_to_file) {
		process.stdout.write = function (data) {
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
		process.stderr.write = function (data) {
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

export function loggerWithTag(tag: string, conditional?: boolean, logger: any = mainLogger) {
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

export function suppressLogging(callback) {
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
let currentServiceName;
let currentTag;
export function createLogger(options: any = {} as any) {
	let {
		path: logFilePath,
		level: logLevel,
		stdStreams: logToStdstreams,
		rotation,
		isExternalInstance,
		writeToLog,
		component,
	}: any = options;
	if (!logLevel) logLevel = 'info';
	let level = typeof logLevel === 'number' ? logLevel : LOG_LEVEL_HIERARCHY[logLevel];
	let logger;
	/**
	 * Log to std out and/or file
	 * @param log
	 */
	function logStdOut(log) {
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
	function logStdErr(log) {
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
	function logPrepend(write) {
		return {
			write(log) {
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
		logger.forComponent = function (name, isExternal = false) {
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
		logger.hasComponent = function (name) {
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
function getFileLogger(path, rotation, isExternalInstance) {
	let logger = fileLoggers.get(path);
	let logFD, loggedFDError, logTimer;
	let logBuffer;
	let logTimeUsage = 0;
	if (!logger) {
		logger = logToFile;
		logger.closeLogFile = closeLogFile;
		logger.path = path;
		fileLoggers.set(path, logger);
	}
	if (isMainThread && JSON.stringify(rotation) !== JSON.stringify(logger.rotation)) {
		logger.rotation = rotation;
		setTimeout(() => {
			logger.rotator?.end();
			if (!rotation) return;
			const { logRotator } = require('./logRotator');
			try {
				logger.rotator = logRotator({
					logger,
					...rotation,
				});
			} catch (error) {
				logger(`Error initializing log rotator (log rotation disabled): ${error.message}`);
			}
		}, 100);
	}
	return logger;
	function logToFile(log) {
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
	function logQueuedData(entry?: any) {
		openLogFile(undefined);
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

	function closeLogFile(_unused?: any) {
		try {
			fs.closeSync(logFD);
		} catch {}
		logFD = null;
		if (isExternalInstance) mainLogFd = null;
	}

	function openLogFile(isRetry?: any) {
		if (!logFD) {
			try {
				logFD = fs.openSync(path, 'a');
				if (isExternalInstance) mainLogFd = logFD;
			} catch (error) {
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
export function info(...args) {
	mainLogger.info(...args);
}

/**
 * Log a trace level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
export function trace(...args) {
	mainLogger.trace(...args);
}

/**
 * Log a error level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
export function error(...args) {
	mainLogger.error(...args);
}

/**
 * Log a debug level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
export function debug(...args) {
	mainLogger.debug(...args);
}

/**
 * Log a notify level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
export function notify(...args) {
	mainLogger.notify(...args);
}

/**
 * Log a fatal level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
export function fatal(...args) {
	mainLogger.fatal(...args);
}

/**
 * Log a warn level log.
 * @param args - rest parameter syntax (...args), allows function to accept indefinite number of args as an array of log messages(strings/objects).
 * Provide args separated by commas. No need to stringify objects. Console will do that
 */
export function warn(...args) {
	mainLogger.warn(...args);
}

export function logCustomLevel(level: any, output: any, options: any, ...args: any[]) {
	currentServiceName = options.service_name;
	try {
		mainLogger[level](...args);
	} finally {
		currentServiceName = undefined;
	}
}

/**
 * This is a duplicate of commonUtils.getPropsFilePath.  We need to have it duplicated here to avoid a circular dependency
 * that happens when commonUtils is imported.
 * @returns {*}
 */
export function getPropsFilePath() {
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

function setLogLevel(level) {
	logLevel = level;
}

/**
 * Reads the harperdb-config.yaml file for log settings.
 * @param hdbConfigPath
 * @returns {{configLogPath: any, rotate: any, level: any, toFile: any, root: any, toStream: any}}
 */
function getLogConfig(hdbConfigPath) {
	try {
		// This is here to accommodate pre 4.0.0 settings files that might exist during upgrade.
		if (hdbConfigPath.includes('config/settings.js')) {
			const oldHdbSettings = PropertiesReader(hdbConfigPath);
			return {
				level: oldHdbSettings.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_LEVEL_KEY),
				configLogPath: pathModule.dirname(oldHdbSettings.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_PATH_KEY)),
				toFile: oldHdbSettings.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_TO_FILE),
				toStream: oldHdbSettings.get(hdbTerms.HDB_SETTINGS_NAMES.LOG_TO_STDSTREAMS),
			};
		}
		const configDoc = YAML.parseDocument(fs.readFileSync(hdbConfigPath, 'utf8'));
		const rootPath = configDoc.getIn(['rootPath']);
		const level = configDoc.getIn(['logging', 'level']);
		const configLogPath = resolveLogPath(configDoc.getIn(['logging', 'root']) as any, rootPath as any);
		const toFile = configDoc.getIn(['logging', 'file']);
		const toStream = configDoc.getIn(['logging', 'stdStreams']);
		const logConsole = configDoc.getIn(['logging', 'console']);
		const colorMode = configDoc.getIn(['logging', 'colors']) ?? true; // default to true
		const rotation = (configDoc.getIn(['logging', 'rotation']) as any)?.toJSON();
		// Resolve rotation path if relative
		if (rotation?.path) {
			rotation.path = resolveLogPath(rotation.path, rootPath as any);
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
	} catch (err) {
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
function getDefaultConfig() {
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
export function errorToString(error: any) {
	if (error == null) return String(error);
	try {
		return typeof error.message === 'string' ? `${error.constructor.name}: ${error.message}` : error.toString();
	} catch {
		// error is hostile (e.g. a revoked Proxy, or a getter that throws) - this must never throw,
		// since it's called directly for response bodies (REST.ts/http.ts/JSONStream) as well as here.
		try {
			return Object.prototype.toString.call(error);
		} catch {
			return '[Unrenderable Object]';
		}
	}
}

// Own-enumerable Error properties considered safe to surface in logs — common diagnostic fields
// (HTTP status, Node error codes) that libraries and app code don't use to carry secrets, unlike
// arbitrary properties (axios' `config`/`request` with an Authorization header), which stay
// excluded. `path` is deliberately omitted: it can reveal internal filesystem layout, and the
// message/stack already names the failing operation.
const LOGGABLE_ERROR_PROPS = ['code', 'status', 'statusCode', 'errno', 'syscall'];

function loggablePropsSuffix(error: any): string {
	if (typeof error !== 'object' || error === null) return '';
	let suffix = '';
	for (const key of LOGGABLE_ERROR_PROPS) {
		try {
			const value = error[key];
			if (value !== undefined) suffix += ` ${key}=${value}`;
		} catch {
			// A hostile property (revoked Proxy, throwing getter) must not crash the logger - skip it.
		}
	}
	return suffix;
}

function renderErrorLine(error: any): string {
	try {
		const base = typeof error?.stack === 'string' ? error.stack : errorToString(error);
		return base + loggablePropsSuffix(error);
	} catch (err) {
		// error?.stack itself can throw on a hostile object even though errorToString cannot.
		return `[Unrenderable Error: ${err instanceof Error ? err.message : String(err)}]`;
	}
}

/**
 * Renders an error to its stack (class name + message + frames) plus a small allowlist of
 * diagnostic properties (see `LOGGABLE_ERROR_PROPS`), then appends the same for each error in its
 * `cause` chain. Deliberately excludes every OTHER own-enumerable property — those are exactly
 * what leaks secrets in #1734 (see `errorForLog`).
 *
 * The `cause` chain is not under this module's control (any code that threw the outer error could
 * have attached a hostile `cause` - a revoked Proxy, an object with a throwing getter), so every
 * step of the walk is defensive: this function must never throw regardless of what it's given.
 */
function errorToLogString(error: any) {
	if (error == null) return String(error);
	let output = renderErrorLine(error);
	const seen = new Set([error]);
	let cause: any;
	try {
		cause = error.cause;
	} catch {
		return output;
	}
	while (cause != null && !seen.has(cause)) {
		seen.add(cause);
		output += `\ncaused by: ${renderErrorLine(cause)}`;
		try {
			cause = cause.cause;
		} catch {
			break;
		}
	}
	return output;
}

/**
 * Returns a log-safe representation of an error for passing to the logger. It renders the stack
 * (class name + message + frames) plus any `cause` chain, but NOT the error's own-enumerable
 * properties.
 *
 * This deliberately avoids logging the raw Error object: Node's Console formats a logged Error with
 * util.inspect, which dumps every own-enumerable property. Anything an app or an HTTP client library
 * stashes on a thrown Error — a credential used for an outbound Authorization header, an axios
 * `config`/`request` with headers — would otherwise land verbatim in hdb.log (see #1734). Those
 * custom properties are not part of the stack, so this preserves debuggability without leaking them.
 *
 * A wrapper carrying the rendering on `util.inspect.custom` is returned rather than a pre-built
 * string so the (potentially expensive) stack materialization only happens if the logger's level
 * gate actually writes the entry — passing a raw string would force it eagerly on the discarded path.
 */
export function errorForLog(error: any) {
	const render = () => errorToLogString(error);
	return { [inspect.custom]: render, toString: render };
}

// Bounds deepSanitizeErrors' walk: deep enough to reach any realistic diagnostic payload shape,
// capped so a pathological/adversarial structure can't blow the stack.
const MAX_SANITIZE_DEPTH = 20;

// Default per-container breadth cap (used when inspectForLog's caller didn't request a specific
// maxArrayLength) and an absolute ceiling on total nodes visited across the WHOLE walk. Per-
// container breadth alone isn't enough: a structure that is merely wide at every one of
// MAX_SANITIZE_DEPTH levels multiplies out to an astronomical node count, so a global counter is
// the actual backstop. Both exist because sanitizing happens BEFORE util.inspect's own
// maxArrayLength truncation runs - a huge/sparse array or a huge Map/Set in a structured error
// (`new Array(0xffffffff)`, or a hostile component's crafted payload) would otherwise force this
// walk to visit billions of entries and wedge the event loop while just trying to log the
// *original* error, before inspect ever gets a chance to truncate the output.
const DEFAULT_MAX_SANITIZE_ENTRIES = 1000;
const MAX_SANITIZE_NODES = 50_000;

interface SanitizeBudget {
	nodes: number;
	maxEntries: number;
}

/** A util.inspect-style placeholder rendered without invoking anything, used both for an unread
 *  accessor property and for a budget-truncated container tail. */
function labelPlaceholder(label: string) {
	return { [inspect.custom]: () => label, toString: () => label };
}

/** A util.inspect-style placeholder for an accessor property, describing it without invoking the
 *  getter — see the getter-invocation note on deepSanitizeErrors below. */
function accessorPlaceholder(descriptor: PropertyDescriptor) {
	return labelPlaceholder(
		descriptor.get && descriptor.set ? '[Getter/Setter]' : descriptor.get ? '[Getter]' : '[Setter]'
	);
}

/**
 * Placeholder substituted when a recursive sanitize step on a child throws, instead of falling
 * back to that child's raw (unsanitized) value. A throw here is not a reason to skip sanitizing -
 * it is exactly the case a hostile value produces (e.g. a Proxy whose `ownKeys` trap throws once
 * reached one level down), and the child that triggered it may itself contain an unsanitized
 * Error. Falling back to raw would silently hand that Error to inspect() at the raised depth,
 * recreating the #1734 leak this whole walk exists to prevent.
 */
function sanitizeFailurePlaceholder() {
	return labelPlaceholder('[Unrenderable value: sanitize failed]');
}

// Unique symbol keys for the plain-object breadth-cap markers below, rather than a string key
// like the array/Map/Set truncation markers use - a hostile or just plain unlucky object could
// have an own string property literally named the same as a string marker, silently colliding
// with (and hiding) real data. A locally-scoped Symbol can never collide with an enumerable
// string OR pre-existing symbol key on the original value.
const KEYS_TRUNCATED_MARKER = Symbol('sanitize: string-keyed properties truncated');
const SYMBOLS_TRUNCATED_MARKER = Symbol('sanitize: symbol-keyed properties truncated');

/**
 * True for the specific built-ins whose actual data is NOT reachable through their own-enumerable
 * string/symbol keys, so rebuilding them via a property walk would silently corrupt their
 * rendering (Object.keys(new Date()) is `[]`; a Buffer's bytes live in a typed-array internal
 * slot, not enumerable own properties). Everything else - an object literal, a class instance, a
 * VM cross-realm object of either - IS walked and rebuilt: a class or custom-prototype instance is
 * just as capable of holding a nested Error as a plain object (`http_resp_msg` is a generic field,
 * not limited to the known deploy payload), and leaving instances raw would hand the raised inspect
 * depth below a real, generic secret-leak path. `types.is*` checks an internal slot, not the
 * prototype chain, so - like isNativeError / types.isMap / types.isSet elsewhere in this file -
 * this is realm-independent: a VM-created Date is still recognized as opaque.
 *
 * Promise is deliberately NOT included here (handled separately in deepSanitizeErrors, see below):
 * unlike the others, a Promise's resolved/rejected value is not merely internal-slot data with a
 * fixed rendering, it's arbitrary caller data - and util.inspect renders it directly, own-enumerable
 * properties and all (`util.inspect(Promise.resolve(errorWithSecretHeader), { depth: 8 })` prints
 * the header). There is no supported synchronous way to read that value in order to sanitize it, so
 * the only safe option is to never hand a Promise to inspect() raw.
 *
 * An *expando* own-enumerable property stashed directly on one of these (e.g. `const d = new
 * Date(); d.cause = secretError`) would otherwise leak the same way the Promise case above does -
 * inspect() renders own-enumerable properties on ANY object, opaque built-ins included. Handled by
 * hasEnumerableOwnProps/safeOpaqueBuiltinSummary below: the fast, zero-cost, common path (no
 * expando) returns the value raw and untouched; only a value actually carrying one pays for a safe
 * replacement.
 */
function isOpaqueBuiltin(value: object): boolean {
	return (
		types.isDate(value) ||
		types.isRegExp(value) ||
		types.isArrayBufferView(value) || // covers Buffer and every TypedArray/DataView
		types.isAnyArrayBuffer(value) ||
		types.isWeakMap(value) ||
		types.isWeakSet(value) ||
		types.isBoxedPrimitive(value) // a boxed Boolean/Number/String/Symbol/BigInt wrapper
	);
}

/**
 * True if `value` has any own-enumerable string or symbol property beyond its own intrinsic data -
 * i.e. an expando - since none of isOpaqueBuiltin's types (nor a bare function) normally carry any.
 * Checked before deciding whether an opaque built-in/function is safe to hand to inspect() raw.
 * Errs conservative: if the check itself cannot be completed safely (a hostile `ownKeys`/descriptor
 * trap), treat that as "has an expando" rather than risk a false "clean" on something we couldn't
 * actually verify.
 *
 * A TypedArray/Buffer's own numeric indices ARE its intrinsic byte/element data, own-enumerable
 * exactly like any other array - `Object.keys(Buffer.from('hi'))` is `['0', '1']` - so those don't
 * count as expandos here; only a key beyond `[0, length)` does. DataView has no such index
 * properties (its data is accessed only via get/set methods), so it's excluded from that carve-out.
 */
function hasEnumerableOwnProps(value: object): boolean {
	try {
		const keys = Object.keys(value);
		if (keys.length > 0) {
			if (ArrayBuffer.isView(value) && typeof (value as any).length === 'number' && !types.isDataView(value)) {
				const length = (value as any).length;
				for (const key of keys) {
					const index = key === '' ? NaN : Number(key);
					if (!(Number.isInteger(index) && index >= 0 && index < length && String(index) === key)) return true;
				}
			} else {
				return true;
			}
		}
		for (const sym of Object.getOwnPropertySymbols(value)) {
			if (Object.getOwnPropertyDescriptor(value, sym)?.enumerable) return true;
		}
		return false;
	} catch {
		return true;
	}
}

/**
 * Returns a value safe to hand to inspect() in place of an opaque built-in that (unusually) carries
 * an expando property - reached only via hasEnumerableOwnProps returning true, never on the common
 * expando-free path. Date/RegExp/WeakMap/WeakSet are cheap to reconstruct byte/value-for-value from
 * their intrinsic prototype (bound explicitly via .call/Reflect.get, not `value.getTime()` etc,
 * exactly so an own property shadowing that method - the same class of hijack the Map/Set branches
 * below guard against - can't run instead of the real accessor); WeakMap/WeakSet never expose their
 * entries via inspect regardless, so a fresh empty instance loses nothing. Buffer/TypedArray/
 * DataView/ArrayBuffer/boxed-primitives are left as a bounded type-tag summary instead: safely
 * reconstructing an exact byte-for-byte or value-for-value copy needs per-subtype branching that
 * isn't worth it for how rarely one of these ever carries an expando in the first place.
 */
function safeOpaqueBuiltinSummary(value: object): any {
	try {
		if (types.isDate(value)) return new Date(Date.prototype.getTime.call(value));
		if (types.isRegExp(value)) {
			const source = Reflect.get(RegExp.prototype, 'source', value);
			const flags = Reflect.get(RegExp.prototype, 'flags', value);
			return new RegExp(source, flags);
		}
		if (types.isWeakMap(value)) return new WeakMap();
		if (types.isWeakSet(value)) return new WeakSet();
	} catch {
		// fall through to the generic tag-only summary below
	}
	let tag = 'value';
	try {
		tag = Object.prototype.toString.call(value).slice(8, -1);
	} catch {
		// leave the generic tag
	}
	return labelPlaceholder(`[${tag} with own properties omitted for safety]`);
}

/** Defines `key` as an own DATA property via defineProperty rather than `target[key] = value`.
 *  Once a sanitized clone's prototype is restored to the original's (see deepSanitizeErrors), a
 *  plain assignment for a key that has an inherited accessor further up that prototype chain would
 *  invoke the INHERITED SETTER instead of creating an own property - running arbitrary code during
 *  what should be a passive render - and a key literally named `__proto__` would hit the legacy
 *  Object.prototype.__proto__ setter and reparent the clone instead of storing a property named
 *  "__proto__". defineProperty always creates/replaces an own property directly, regardless of key
 *  name or what the prototype chain declares. */
function defineOwnProperty(target: any, key: string | symbol, value: any) {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Recursively walks a plain object/array, replacing every Error-like value found at any depth
 * with its errorForLog wrapper (see isErrorLike/errorForLog and #1734). sanitizeErrorArgs is
 * deliberately shallow because it guards the hot, frequent top-level log-call path — this walk is
 * for inspectForLog's callers instead, which are low-frequency (a caught error's diagnostic
 * detail), so the extra traversal cost doesn't matter and full coverage does: an Error nested
 * anywhere inside a value later rendered with a raised inspect depth (see inspectForLog) would
 * otherwise surface its own-enumerable properties raw.
 *
 * Arrays, Map, Set, and every other object EXCEPT the isOpaqueBuiltin exclusions above are rebuilt
 * so an Error nested inside them at any depth is still reached and sanitized - a raw Error left
 * unsanitized anywhere in the tree would surface its own-enumerable properties (e.g. an axios
 * `config.headers.Authorization`) raw once the raised inspect depth below reaches it. A rebuilt
 * object/class-instance clone has the original's prototype restored (Object.setPrototypeOf) so
 * inspect() still shows its real class name and picks up any inspect.custom hook defined on the
 * class's prototype (not an own property, so the symbol walk below wouldn't otherwise see it) -
 * the clone differs from the original only in which of its OWN enumerable properties got swapped
 * for a sanitized/placeholder value, same as it would for a plain object.
 *
 * Cycle-safe via a WeakMap from original to its (in-progress) clone, registered before recursing
 * into children, so a cycle resolves to the clone in progress rather than falling back to the raw
 * original (which would bypass sanitization on the repeated branch) - and depth-capped so a
 * pathologically deep structure can't blow the stack. Every property read and recursive step is
 * individually guarded so one hostile getter or exotic nested value can only cost that one
 * field, not the whole render (inspectForLog's own try/catch around inspect() is still the final
 * backstop regardless).
 *
 * Never invokes an accessor (getter) property, and never resolves an overridable Symbol.iterator:
 * unlike util.inspect's default (which shows a getter as `[Getter]` without calling it), reading
 * `value[key]`/`value[sym]` for every own-enumerable key - or iterating an array/Map/Set with
 * `for...of`, which resolves the value's own-or-inherited `Symbol.iterator` - would run arbitrary
 * synchronous code, including a subclass instance's overridden iterator, while the logger is just
 * trying to report the *original* error (a hostile accessor/iterator that loops, blocks, or
 * mutates state runs regardless). Arrays are walked by own property descriptor per index instead
 * of `for...of`; Map/Set are walked via their intrinsic prototype methods bound with `.call`,
 * which reads the internal slot data directly rather than going through the instance's own (or an
 * overriding subclass's) iterator method. Objects read property descriptors and recurse only into
 * a data descriptor's value; an accessor gets accessorPlaceholder's label instead. Every own
 * property is written via defineOwnProperty rather than assignment, so a clone whose prototype was
 * restored to a class's prototype can't trigger an inherited setter (or the legacy `__proto__`
 * setter) partway through the walk.
 *
 * Breadth-bounded via `budget`, shared across the whole walk (not reset per container): each
 * container is capped at `budget.maxEntries` entries (with a placeholder noting what was
 * skipped), and the walk stops sanitizing entirely past `MAX_SANITIZE_NODES` total nodes visited,
 * regardless of per-container caps - see the constants' comment for why both are needed.
 */
function deepSanitizeErrors(
	value: any,
	seen: WeakMap<object, any> = new WeakMap(),
	depth = 0,
	budget: SanitizeBudget = { nodes: 0, maxEntries: DEFAULT_MAX_SANITIZE_ENTRIES }
): any {
	// Functions are `typeof 'function'`, not 'object' - included here (rather than falling through
	// as if they were a harmless primitive) because a function is just as capable of carrying an
	// expando own-enumerable property (`fn.cause = secretError`, an ordinary and not-even-unusual
	// JS pattern) as a plain object is, and inspect() renders those own properties the same way.
	// Counted first, before even the primitive-leaf check below, so a primitive leaf (string/number/
	// etc in an array/object, the overwhelmingly common case) consumes exactly as much of the shared
	// budget as a container does. Without this, only container nodes counted towards
	// MAX_SANITIZE_NODES while each one's up-to-budget.maxEntries primitive children were free, so
	// e.g. 50,000 containers of 250 primitive fields each could still walk ~12.5 million values
	// before this cap ever engaged.
	if (++budget.nodes > MAX_SANITIZE_NODES) return labelPlaceholder('[Unrenderable value: sanitize budget exceeded]');
	if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
	if (isErrorLike(value)) return errorForLog(value);
	if (seen.has(value)) return seen.get(value);
	if (depth >= MAX_SANITIZE_DEPTH) return value;

	let isArray: boolean, isMap: boolean, isSet: boolean, isFunction: boolean;
	try {
		isArray = Array.isArray(value);
		// types.isMap/isSet check an internal slot, not the prototype chain, so (like isNativeError)
		// they still recognize a Map/Set created in a different realm (component code runs through
		// node:vm) - `instanceof Map`/`Set` would not, silently leaving that container's contents
		// (and any Error nested inside) unsanitized at the raised inspect depth below.
		isMap = !isArray && types.isMap(value);
		isSet = !isArray && !isMap && types.isSet(value);
		isFunction = !isArray && !isMap && !isSet && typeof value === 'function';
		// See the Promise note on isOpaqueBuiltin above: its resolved/rejected value is arbitrary
		// caller data that inspect() renders directly (own-enumerable properties included), and there
		// is no supported synchronous way to read it in order to sanitize it - so unlike every other
		// opaque built-in, a Promise is never handed to inspect() raw, sanitized or not.
		if (!isArray && !isMap && !isSet && types.isPromise(value)) return labelPlaceholder('[Promise]');
		if (!isArray && !isMap && !isSet && !isFunction && isOpaqueBuiltin(value)) {
			// Fast, faithful, zero-cost path for the overwhelming common case: no expando, so the
			// value is returned exactly as-is and inspect() renders its normal native format. Only a
			// value that actually carries an expando pays for safeOpaqueBuiltinSummary below.
			if (!hasEnumerableOwnProps(value)) return value;
			return safeOpaqueBuiltinSummary(value);
		}
		if (isFunction && !hasEnumerableOwnProps(value)) return value; // same fast path, for functions
	} catch {
		return value; // e.g. a revoked Proxy - util.inspect renders those fine on its own
	}
	// A function reaching here carries an expando: fall through into the generic object walk below
	// (Object.keys/getOwnPropertyDescriptor/getOwnPropertySymbols all work the same on a function as
	// on a plain object) so that expando gets sanitized like any other object's - the clone won't be
	// callable and inspect() renders it as a plain `Function { ... }` rather than `[Function: name]`,
	// but that's a safe, honest trade for a case inspect() would otherwise render with a raw,
	// unsanitized secret alongside it.

	if (isArray) {
		const clone: any[] = [];
		seen.set(value, clone);
		const length = value.length;
		// Reserve one slot for the truncation marker when overflowing, so the clone's final size is
		// exactly budget.maxEntries - matching whatever maxArrayLength the caller will inspect() with
		// - rather than maxEntries + 1, which util.inspect's OWN truncation would then clip anyway,
		// silently hiding the marker (and the fact that anything was dropped at all) behind its
		// generic "... N more items" ellipsis.
		const overflow = length > budget.maxEntries;
		const limit = overflow ? budget.maxEntries - 1 : length;
		for (let i = 0; i < limit; i++) {
			let descriptor;
			try {
				descriptor = Object.getOwnPropertyDescriptor(value, i);
			} catch {
				continue; // leave index i a hole rather than risk a second throw
			}
			if (!descriptor) continue; // a genuine sparse-array hole - leave it, not `undefined`
			if (descriptor.get || descriptor.set) {
				clone[i] = accessorPlaceholder(descriptor);
				continue;
			}
			try {
				clone[i] = deepSanitizeErrors(descriptor.value, seen, depth + 1, budget);
			} catch {
				clone[i] = sanitizeFailurePlaceholder();
			}
		}
		if (overflow) clone[limit] = labelPlaceholder(`[${length - limit} more array entries omitted (sanitize budget)]`);
		return clone;
	}

	if (isMap) {
		const clone = new Map();
		seen.set(value, clone);
		// Reflect.get with an explicit receiver reads Map.prototype's intrinsic `size` getter bound
		// to value's internal slot, bypassing an overriding subclass's own `size` the same way the
		// .call-bound entries() below bypasses an overriding subclass's Symbol.iterator.
		const size = Reflect.get(Map.prototype, 'size', value);
		const overflow = size > budget.maxEntries;
		const limit = overflow ? budget.maxEntries - 1 : size;
		let count = 0;
		// Map.prototype.entries bound via .call reads the internal [[MapData]] slot directly,
		// rather than resolving value's own (or an overriding subclass's) Symbol.iterator.
		for (const [k, v] of Map.prototype.entries.call(value)) {
			if (count++ >= limit) break;
			// Sanitized independently (rather than in one combined try) so a throw sanitizing the key
			// doesn't also discard an already-sanitized value, or vice versa - each side falls back to
			// its own placeholder, never to the other's raw counterpart.
			let sanitizedKey, sanitizedValue;
			try {
				sanitizedKey = deepSanitizeErrors(k, seen, depth + 1, budget);
			} catch {
				sanitizedKey = sanitizeFailurePlaceholder();
			}
			try {
				sanitizedValue = deepSanitizeErrors(v, seen, depth + 1, budget);
			} catch {
				sanitizedValue = sanitizeFailurePlaceholder();
			}
			clone.set(sanitizedKey, sanitizedValue);
		}
		if (overflow)
			clone.set(
				labelPlaceholder('[truncated]'),
				labelPlaceholder(`[${size - limit} more Map entries omitted (sanitize budget)]`)
			);
		return clone;
	}

	if (isSet) {
		const clone = new Set();
		seen.set(value, clone);
		const size = Reflect.get(Set.prototype, 'size', value);
		const overflow = size > budget.maxEntries;
		const limit = overflow ? budget.maxEntries - 1 : size;
		let count = 0;
		// Same rationale as the Map branch above: Set.prototype.values via .call, not for...of.
		for (const item of Set.prototype.values.call(value)) {
			if (count++ >= limit) break;
			try {
				clone.add(deepSanitizeErrors(item, seen, depth + 1, budget));
			} catch {
				clone.add(sanitizeFailurePlaceholder());
			}
		}
		if (overflow) clone.add(labelPlaceholder(`[${size - limit} more Set entries omitted (sanitize budget)]`));
		return clone;
	}

	const result: Record<string | symbol, any> = {};
	seen.set(value, result);
	try {
		Object.setPrototypeOf(result, Object.getPrototypeOf(value));
	} catch {
		// leave result's prototype as plain Object - inspect() renders it without the class name
	}
	// Object.keys/getOwnPropertySymbols themselves are one unavoidable O(n) pass (a plain object,
	// unlike Array/Map/Set, has no O(1) size to check before enumerating) - but everything AFTER
	// that (getOwnPropertyDescriptor + recurse + defineProperty per key) is the expensive part, and
	// that part IS capped at budget.maxEntries, same as every other container branch, so a
	// million-key object can't turn a single log call into a million-entry clone.
	const keys = Object.keys(value);
	const keysOverflow = keys.length > budget.maxEntries;
	const keysLimit = keysOverflow ? budget.maxEntries - 1 : keys.length;
	for (let i = 0; i < keysLimit; i++) {
		const key = keys[i];
		let descriptor;
		try {
			descriptor = Object.getOwnPropertyDescriptor(value, key);
		} catch {
			continue; // a hostile descriptor trap - omit rather than risk a second throw
		}
		if (!descriptor) continue; // removed mid-walk by another property's getter side effect
		if (descriptor.get || descriptor.set) {
			defineOwnProperty(result, key, accessorPlaceholder(descriptor));
			continue;
		}
		try {
			defineOwnProperty(result, key, deepSanitizeErrors(descriptor.value, seen, depth + 1, budget));
		} catch {
			defineOwnProperty(result, key, sanitizeFailurePlaceholder());
		}
	}
	if (keysOverflow)
		defineOwnProperty(
			result,
			KEYS_TRUNCATED_MARKER,
			labelPlaceholder(`[${keys.length - keysLimit} more properties omitted (sanitize budget)]`)
		);
	const symbols = Object.getOwnPropertySymbols(value);
	const symbolsOverflow = symbols.length > budget.maxEntries;
	const symbolsLimit = symbolsOverflow ? budget.maxEntries - 1 : symbols.length;
	for (let i = 0; i < symbolsLimit; i++) {
		const sym = symbols[i];
		let descriptor;
		try {
			descriptor = Object.getOwnPropertyDescriptor(value, sym);
		} catch {
			continue;
		}
		if (!descriptor?.enumerable) continue;
		if (sym === inspect.custom) {
			// The custom renderer itself, not data - preserve unchanged (even if defined via an
			// accessor) rather than replace it with an accessor placeholder. util.inspect's own
			// top-level render finds this hook via the exact same `value[sym]` property access, so
			// reading it here isn't new arbitrary-code exposure the way an ordinary data getter
			// would be - it's the documented render-hook contract, just resolved one level earlier.
			try {
				defineOwnProperty(result, sym, value[sym]);
			} catch {
				// leave unset - inspect() will render the rest of the object without a custom hook
			}
			continue;
		}
		if (descriptor.get || descriptor.set) {
			defineOwnProperty(result, sym, accessorPlaceholder(descriptor));
			continue;
		}
		try {
			defineOwnProperty(result, sym, deepSanitizeErrors(descriptor.value, seen, depth + 1, budget));
		} catch {
			defineOwnProperty(result, sym, sanitizeFailurePlaceholder());
		}
	}
	if (symbolsOverflow)
		defineOwnProperty(
			result,
			SYMBOLS_TRUNCATED_MARKER,
			labelPlaceholder(`[${symbols.length - symbolsLimit} more symbol properties omitted (sanitize budget)]`)
		);
	return result;
}

/**
 * Returns a log-safe lazy wrapper around `util.inspect(value, options)`, for call sites that need
 * to log a structured, non-Error value with non-default inspect options (e.g. a deeper depth or
 * higher array/string limits than Console's defaults, to avoid flattening nested diagnostic data —
 * see harper#1982). Same rationale as errorForLog: the wrapper defers the (potentially expensive,
 * e.g. large-array) render until the logger's level gate actually writes the entry, and the render
 * itself can never throw regardless of what `value` is — including a hostile nested
 * `[util.inspect.custom]` hook — so a formatting failure can never mask the real thing being
 * logged (e.g. replace the caught operation error with an inspect error). Any Error nested inside
 * `value` is sanitized via deepSanitizeErrors before rendering, so a raised inspect depth here
 * can't surface a nested Error's own-enumerable properties (#1734) the way the raw value would.
 * `options.maxArrayLength`, if given, also bounds sanitization's own per-container breadth (see
 * deepSanitizeErrors' budget) - a caller raising the render limit is raising how much genuinely
 * needs to be walked, not just how much of an already-cheap walk gets displayed.
 */
export function inspectForLog(value: any, options?: any) {
	const render = () => {
		try {
			const maxEntries = Number(options?.maxArrayLength);
			const budget: SanitizeBudget = {
				nodes: 0,
				maxEntries: maxEntries > 0 ? maxEntries : DEFAULT_MAX_SANITIZE_ENTRIES,
			};
			return inspect(deepSanitizeErrors(value, new WeakMap(), 0, budget), options);
		} catch (err) {
			// errorToString is the guaranteed-never-throw stringifier (unlike `err instanceof Error` or
			// `String(err)` here, both of which can themselves throw on a hostile value - e.g. a revoked
			// Proxy thrown by a nested custom-inspect hook - which would otherwise escape this catch and
			// mask the real operation error being logged).
			return `[Unrenderable value: ${errorToString(err)}]`;
		}
	};
	return { [inspect.custom]: render, toString: render };
}

export function setMainLogger(logger: any) {
	mainLogger = logger;
}
function closeLogFile() {
	try {
		fs.closeSync(mainLogFd);
	} catch {}
	mainLogFd = null;
}

export function AuthAuditLog(
	this: any,
	username: any,
	status: any,
	type: any,
	originatingIp: any,
	requestMethod: any,
	path: any
) {
	this.username = username;
	this.status = status;
	this.type = type;
	this.originating_ip = originatingIp;
	this.request_method = requestMethod;
	this.path = path;
}
// we have to load this at the end to avoid circular dependencies problems
import { RootConfigWatcher } from '../../config/RootConfigWatcher.ts';

export const getLogFilePath = () => logFilePath;
export const forComponent = (name: string, isExternal?: boolean) => mainLogger.forComponent(name, isExternal);
export default {
	notify,
	fatal,
	error,
	warn,
	info,
	debug,
	trace,
	get logLevel() {
		return logLevel;
	},
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
	OUTPUTS,
	disableStdio,
	externalLogger,
	AuthAuditLog,
	errorToString,
	errorForLog,
	inspectForLog,
	isErrorLike,
};
