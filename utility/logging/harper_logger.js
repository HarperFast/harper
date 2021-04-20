'use strict';
/**
 * This module decouples a logging call from any specific logging implementation or module (e.g. Winston).  It currently
 * support Winston and Pino though it should be easy to add additional supported loggers if needed.  The logging levels
 * supported follow the Pino default log levels.  The Winston log levels have been replaced, as the default levels are
 * dumb (see: silly log level).
 *
 * Log levels can be set dynamically at run time through the setLogLevel function.  They type of logger can also be set
 * at run time, thought the usefulness of this is debatable.
 *
 */

const winston = require('winston');
require('winston-daily-rotate-file');
const pino = require('pino');
const fs = require('fs');
const moment = require('moment');
const path = require('path');
const util = require('util');
const validator = require('../../validation/readLogValidator');
const os = require('os');
const terms = require('../hdbTerms');

//Using numbers rather than strings for faster comparison
const WIN = 1;
const PIN = 2;
// Set interval that log buffer should be flushed at.
const LOG_BUFFER_FLUSH_INTERVAL = 10000;

const NOTIFY = 'notify';
const FATAL = 'fatal';
const ERR = 'error';
const WARN = 'warn';
const INFO = 'info';
const DEBUG = 'debug';
const TRACE = 'trace';

const DEFAULT_LOGGER_FIELDS = {
    WIN: ['level','message','timestamp'],
    PIN: ['level','msg','time']
};

const LOGGER_TYPE = {
    RUN_LOG: "run_log",
    INSTALL_LOG: "install_log",
    HDB_LOG: "hdb_log"
};

const LOGGER_PATH = {
    INSTALL_LOG: "../install_log.log",
    RUN_LOG: "../run_log.log"
};

const DEFAULT_LOG_FILE_NAME = 'hdb_log.log';

let log_location = undefined;
// Variables used for log daily rotation
let log_directory = undefined;
let log_file_name = undefined;

let pino_logger = undefined;
let win_logger = undefined;

// read environment settings to get preferred logger and default log level
const PropertiesReader = require('properties-reader');
let daily_rotate;
let max_daily_files;
let log_level;
let log_type;
let log_path;
let daily_max;
let hdb_properties;
if (hdb_properties === undefined) {
    try {
        let boot_props_file_path = getPropsFilePath();
        hdb_properties = PropertiesReader(boot_props_file_path);
        hdb_properties.append(hdb_properties.get('settings_path'));
        daily_rotate = `${hdb_properties.get('LOG_DAILY_ROTATE')}`.toLowerCase() === 'true';
        daily_max = hdb_properties.get('LOG_MAX_DAILY_FILES');
        max_daily_files = daily_max ? daily_max + 'd' : null;
        log_level = hdb_properties.get('LOG_LEVEL');
        log_type = hdb_properties.get('LOGGER');
        log_path = hdb_properties.get('LOG_PATH');

        setLogLocation(log_path);
    } catch(err) {
        // In early stage like install or run, settings file and folder is not available yet so let it takes default settings below
    }
}

if (log_level === undefined || log_level === 0 || log_level === null) {
    log_level = 'error';
}

if (log_path === undefined || log_path === null) {
    log_location = '../run_log.log';
}

module.exports = {
    trace:trace,
    debug:debug,
    info:info,
    warn:warn,
    error:error,
    fatal:fatal,
    notify:notify,
    setLogLevel:setLogLevel,
    setLogType:setLogType,
    write_log:write_log,
    readLog:readLog,
    log_level,
    NOTIFY,
    FATAL,
    ERR,
    WARN,
    INFO,
    DEBUG,
    TRACE
};

/**
 * Initialize the Pino logger with custom levels
 */
function initPinoLogger() {
    pino_logger = pino(
    {
            customLevels: {
                notify: 70,
                fatal: 60,
                error: 50,
                warn: 40,
                info: 30,
                debug: 20,
                trace: 10
            },
            useOnlyCustomLevels:true,
            level: log_level,
            name: 'HarperDB',
            timestamp: pino.stdTimeFunctions.isoTime,
            formatters: {
                bindings() {
                    return undefined; // Removes pid and hostname from log
                },
                level (label) {
                    return { level: label };
                }
            },
        },
        pino.destination(
    {
            dest: log_location,
            minLength: 4096, // Buffer before writing
            sync: false // Asynchronous logging
        }
    ));

    // asynchronously flush every 10 seconds to keep the buffer empty
    // in periods of low activity
    setInterval(function () {
        pino_logger.flush();
    }, LOG_BUFFER_FLUSH_INTERVAL).unref();

    // use pino.final to create a special logger that
    // guarantees final tick writes
    const handler = pino.final(pino_logger, (err, finalLogger, evt) => {
        finalLogger.info(`${evt} caught`);
        if (err) finalLogger.error(err, 'error caused exit');
        process.exit(err ? 1 : 0);
    });

    // catch all the ways node might exit, if one occurs anything in the log buffer will be written to logs.
    process.on('beforeExit', () => handler(null, 'beforeExit'));
    process.on('exit', () => handler(null, 'exit'));
    process.on('uncaughtException', (err) => handler(err, 'uncaughtException'));
    process.on('SIGINT', () => handler(null, 'SIGINT'));
    process.on('SIGQUIT', () => handler(null, 'SIGQUIT'));
    process.on('SIGTERM', () => handler(null, 'SIGTERM'));
}

/**
 * This helper function will take the log level and message as parameters, and write to the log using
 * the logger configured in the settings file.
 * @param {string|number|null} level - The log level this message should be written to
 * @param {String} message - The message to be written to the log
 */
function write_log(level, message) {
    if (level === undefined || level === 0 || level === null) {
        level = 'error';
    }

    if (!pino_logger) {
        initPinoLogger();
        trace(`Initialized pino logger writing to ${log_location} process pid ${process.pid}`);
    }

    pino_logger[level](message);
}

/**
 * Writes a info message to the log.
 * @param {string} message - The string message to write to the log
 */
function info(message) {
    write_log(INFO, message);
}

/**
 * Writes a trace message to the log.
 * @param {string} message - The string message to write to the log
 */
function trace(message) {
    write_log(TRACE, message);
}

/**
 * Writes a error message to the log.
 * @param {string} message - The string message to write to the log
 */
function error(message) {
    write_log(ERR, message);
}

/**
 * Writes a fatal message to the log.
 * @param {string} message - The string message to write to the log
 */
function fatal(message) {
    write_log(FATAL, message);
}

/**
 * Writes a debug message to the log.
 * @param {string} message - The string message to write to the log
 */
function debug(message) {
    write_log(DEBUG, message);
}

/**
 * Writes a warn message to the log.
 * @param {string} message - The string message to write to the log
 */
function warn(message) {
    write_log(WARN, message);
}

/**
 * Writes a notify message to the log.
 * @param {string} message - The string message to write to the log
 */
function notify(message) {
    write_log(NOTIFY, message);
}

/**
 * Set the log level for the HDB Processes.  Default is error.  Options are trace, debug, info, error, fatal.
 * @param {string} level - The logging level for the HDB processes.
 */
function setLogLevel(level) {
    let log_index = Object.keys(winston_log_levels).indexOf(level);

    if (log_index !== -1) {
        switch (log_type) {
            case WIN:
                //WINSTON
                if (win_logger === undefined) {
                    log_level = level;
                    return;
                }

                //Winston is strange, it has a log level at the logger level, the transport level, and each individual transport.
                win_logger.level = level;
                win_logger.transports.level = level;
                if (daily_rotate) {
                    win_logger.transports.dailyRotateFile.level = level;
                } else {
                    win_logger.transports.file.level = level;
                }
                break;

            case PIN:
                //PINO
                if(pino_logger === undefined) {
                    log_level = level;
                    return;
                }
                pino_logger.level = level;
                break;

            default:
                //WINSTON is default
                if (win_logger === undefined) {
                    log_level = level;
                    return;
                }
                //Winston is strange, it has a log level at the logger level, the transport level, and each individual transport.
                win_logger.level = level;
                win_logger.transports.level = level;
                if (daily_rotate) {
                    win_logger.transports.dailyRotateFile.level = level;
                } else {
                    win_logger.transports.file.level = level;
                }
                break;
        }

        log_level = level;
    } else {
        write_log(INFO, `Log level could not be updated to ${level}, that level is not valid.`);
    }
}

/**
 * Set the logger type used by the HDB process.
 * @param type = The logger to use.  1 = Winston, 2 = Pino.  Any other values
 * will be ignored with an error logged.
 */
function setLogType(type) {
    if (type > PIN || type < WIN) {
        write_log(ERR, `logger type ${type} is invalid`);
        return;
    }
    win_logger = undefined;
    pino_logger = undefined;
    log_type = type;
}

/**
 * Set a location for the log file to be written.  Will stop writing to any existing logs and start writing to the new location.
 * @param log_location_setting
 */
function setLogLocation(log_location_setting) {
    const default_log_directory = hdb_properties.get('HDB_ROOT') + '/log/';
    //if log location isn't defined, assume HDB_ROOT/log/hdb_log.log
    if (log_location_setting === undefined || log_location_setting === 0 || log_location_setting === null) {
        log_directory = default_log_directory;
        log_file_name = DEFAULT_LOG_FILE_NAME;
    } else {
        try {
            const has_log_ext = path.extname(log_location_setting).length > 1;
            if (has_log_ext) {
                const log_settings_directory = path.parse(log_location_setting).dir;
                const log_settings_name = path.parse(log_location_setting).base;

                if (fs.existsSync(log_settings_directory)) {
                    log_directory = log_settings_directory;
                    log_file_name = log_settings_name;
                } else {
                    log_directory = log_settings_directory;
                    log_file_name = log_settings_name;
                    try {
                        fs.mkdirSync(log_settings_directory,{ recursive: true });
                    } catch(err) {
                        write_log(INFO, `Attempted to create log directory from settings file but failed.  Using default log path - 'hdb/log/hdb_log.log'`);
                        log_directory = default_log_directory;
                        log_file_name = DEFAULT_LOG_FILE_NAME;
                    }
                }
            } else {
                if (fs.existsSync(log_location_setting)) {
                    log_directory = log_location_setting;
                    log_file_name = DEFAULT_LOG_FILE_NAME;
                } else {
                    log_directory = log_location_setting;
                    try {
                        fs.mkdirSync(log_location_setting,{ recursive: true });
                    } catch(err) {
                        write_log(INFO, `Attempted to create log directory from settings file but failed.  Using default log path - 'hdb/log/hdb_log.log'`);
                        log_directory = default_log_directory;
                    }

                    log_file_name = DEFAULT_LOG_FILE_NAME;
                }
            }
        } catch(e) {
            write_log(INFO, `Attempted to create log directory from settings file but failed.  Using default log path - 'hdb/log/hdb_log.log'`);
            log_directory = default_log_directory;
            log_file_name = DEFAULT_LOG_FILE_NAME;
        }
    }

    log_location = daily_rotate ? path.join(log_directory, `%DATE%_${log_file_name}`) : path.join(log_directory, log_file_name);

    if (!pino_logger) {
        initPinoLogger();
        trace(`Initialized pino logger writing to ${log_location} process pid ${process.pid}`);
    }
}

let bones = winston;

async function readLog(read_log_object) {
    let validation = validator(read_log_object);

    if (validation) {
        throw new Error(validation);
    }

    const options = {
        limit: 100
    };

    switch (log_type) {
        case WIN:
            options.fields = DEFAULT_LOGGER_FIELDS.WIN;
            break;

        case PIN:
            if (read_log_object.log === LOGGER_TYPE.INSTALL_LOG) {
                options.fields = DEFAULT_LOGGER_FIELDS.WIN;
            } else {
                options.fields = DEFAULT_LOGGER_FIELDS.PIN;
            }
            break;

        default:
            options.fields = DEFAULT_LOGGER_FIELDS.WIN;
            break;
    }

    switch (read_log_object.log) {
        case LOGGER_TYPE.INSTALL_LOG:
            configureWinstonForQuery(LOGGER_PATH.INSTALL_LOG);
            break;

        case LOGGER_TYPE.RUN_LOG:
            configureWinstonForQuery(LOGGER_PATH.RUN_LOG);
            break;

        default:
            configureWinstonForQuery();
            break;
    }

    if (read_log_object.from) {
        options.from = moment(read_log_object.from);
    }

    if (read_log_object.until) {
        options.until = moment(read_log_object.until);
    }

    if (read_log_object.level) {
        options.level = read_log_object.level;
    }

    if (read_log_object.limit) {
        options.limit = read_log_object.limit;
    }

    if (read_log_object.order) {
        options.order = read_log_object.order;
    }

    if (read_log_object.start) {
        options.start = read_log_object.start;
    }

    const p_query = util.promisify(winston.query);

    try {
        return await p_query(options);
    } catch(e) {
        error(e);
        throw e;
    }
}

function configureWinstonForQuery(log_path) {
    if (daily_rotate && !log_path && log_type === WIN) {
        bones.configure({
            transports: [
                new (winston.transports.DailyRotateFile)({
                    filename: path.join(log_directory, `%DATE%_${log_file_name}`),
                    json: true,
                })
            ],
            exitOnError: false
        });
    } else {
        const query_path = log_path ? log_path : log_location;
        bones.configure({
            transports: [
                new (winston.transports.File)({
                    filename: query_path
                })
            ],
            exitOnError: false
        });
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
    } catch(err) {
        // could get here in android
        home_dir = process.env.HOME;
    }
    if(!home_dir) {
        home_dir = '~/';
    }

    let _boot_props_file_path = path.join(home_dir, terms.HDB_HOME_DIR_NAME, terms.BOOT_PROPS_FILE_NAME);
    // this checks how we used to store the boot props file for older installations.
    if(!fs.existsSync(_boot_props_file_path)) {
        _boot_props_file_path = path.join(__dirname, '../', 'hdb_boot_properties.file');
    }
    return _boot_props_file_path;
}
