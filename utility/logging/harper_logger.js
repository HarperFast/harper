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

let daily_rotate = undefined;
let max_daily_files = undefined;
let log_level = undefined;
let log_type = undefined;
let log_location = undefined;
// Variables used for log daily rotation
let log_directory = undefined;
let hdb_log_file_name = undefined;

// read environment settings to get preferred logger and default log level
const PropertiesReader = require('properties-reader');
let hdb_properties = undefined;
let boot_props_file_path = getPropsFilePath();

try {
    hdb_properties = PropertiesReader(boot_props_file_path);
    hdb_properties.append(hdb_properties.get('settings_path'));

    // read environment settings to get log settings
    daily_rotate = hdb_properties.get('LOG_DAILY_ROTATE');
    const daily_max = hdb_properties.get('LOG_MAX_DAILY_FILES');
    max_daily_files = daily_max ? daily_max + 'd' : null;
    log_level = hdb_properties.get('LOG_LEVEL');
    log_type = hdb_properties.get('LOGGER');
    log_location = hdb_properties.get('LOG_PATH');

    //if log location isn't defined, assume HDB_ROOT/log/hdb_log.log
    if (log_location === undefined || log_location === 0 || log_location === null) {
        log_location = (hdb_properties.get('HDB_ROOT') + '/log/hdb_log.log');
    }

    //setting directory location for Winston daily logs
    log_directory = getLogDirectory(log_location);
    hdb_log_file_name = path.parse(log_location).base;
} catch (e) {
    // in early stage like install or run, settings file and folder is not available yet so let it takes default settings below
}

//  RFC5424: severity of all levels is assumed to be numerically ascending from most important to least important
const winston_log_levels = {
    notify: 0,
    fatal: 1,
    error: 2,
    warn: 3,
    info: 4,
    debug: 5,
    trace: 6
};

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

//TODO: All of this should be happening in an env variable module (yet to be written).
if (log_level === undefined || log_level === 0 || log_level === null) {
    log_level = ERR;
}

//TODO: All of this should be happening in an env variable module (yet to be written).
if (log_type === undefined || log_type === 0 || log_type === null) {
    log_type = WIN;
}

//TODO: All of this should be happening in an env variable module (yet to be written).
if (log_location === undefined || log_location === null) {
    log_location = '../run_log.log';
}

//TODO: not sure if this set to global is needed or useful.  This should be happening in a module.
global.log_level = log_level;
global.log_location = log_location;
global.log_directory = log_directory;

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
    setLogLocation:setLogLocation,
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

let pin_logger = undefined;
let win_logger = undefined;

/**
 * initialize the winston logger
 */
function initWinstonLogger() {
    try {
        if (!daily_rotate || log_location === LOGGER_PATH.RUN_LOG) {
            win_logger = new (winston.Logger)({
                transports: [
                    new (winston.transports.File)({
                        level: log_level,
                        filename: log_location,
                        handleExceptions: true,
                        prettyPrint: true
                    })
                ],
                levels: winston_log_levels,
                level: log_level,
                exitOnError: false
            });
        } else {
            win_logger = new (winston.Logger)({
                transports: [
                    new (winston.transports.DailyRotateFile)({
                        filename: path.join(log_directory, `%DATE%_${hdb_log_file_name}`),
                        handleExceptions: true,
                        level: log_level,
                        maxFiles: max_daily_files,
                        prettyPrint: true,
                        json: true,
                        zippedArchive: true
                    })
                ],
                levels: winston_log_levels,
                level: log_level,
                exitOnError: false
            });
        }
    } catch (err) {
        // if this fails we have no logger, so just write to the console and rethrow so everything fails.
        console.error('There was an error initializing the logger.');
        console.error(err);
        throw err;
    }
}

/**
 * Initialize the Pino logger with custom levels
 */
function initPinoLogger() {
    const pino_write_stream = fs.createWriteStream(log_location, {'flags': 'a'});
    win_logger = undefined;
    pin_logger = pino(
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
            name: 'harperDB'
        },
        pino_write_stream
    );
}

/**
 * This helper function will take the log level and message as parameters, and write to the log using
 * the logger configured in the settings file.
 * @param {string} level - The log level this message should be written to
 * @param {String} message - The message to be written to the log
 */
function write_log(level, message) {
    // The properties reader returns an object with a length of 0 if a value isn't found.
    if (log_type === undefined || log_type === 0 || log_type === null) {
        log_type = 1;
    }
    if (level === undefined || level === 0 || level === null) {
        level = ERR;
    }

    switch (log_type) {
        case WIN:
            //WINSTON
            if (!win_logger) {
                initWinstonLogger();
                trace(`initialized winston logger writing to ${log_location}`);
            }
            win_logger.log(level, message);
            break;

        case PIN:
            //PINO
            if (!pin_logger) {
                initPinoLogger();
                trace(`initialized pino logger writing to ${log_location}`);
            }
            pin_logger[level](message);
            break;

        default:
            //WINSTON is default
            if (!win_logger) {
                initWinstonLogger();
                trace(`initialized winston logger writing to ${log_location}`);
            }
            win_logger.log(level, message);
            break;
    }
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
                    global.log_level = level;
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
                if(pin_logger === undefined) {
                    log_level = level;
                    global.log_level = level;
                    return;
                }
                pin_logger.level = level;
                break;

            default:
                //WINSTON is default
                if (win_logger === undefined) {
                    log_level = level;
                    global.log_level = level;
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
        global.log_level = level;
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
    log_type = type;
}

/**
 * Parses file path and returns directory path
 * @param log_path file path
 * @returns {string} directory path
 */
function getLogDirectory(log_path) {
    return path.parse(log_path).dir;
}

/**
 * Set a location for the log file to be written.  Will stop writing to any existing logs and start writing to the new location.
 * @param log_path file path for logging
 */
function setLogLocation(log_path) {
    if (!log_path || log_path.length === 0) {
        error(`An invalid log path was sent to the logger.`);
        return;
    }
    win_logger = undefined;
    pin_logger = undefined;
    log_location = log_path;
    global.log_location = log_path;
    log_directory = getLogDirectory(log_path);
    global.log_directory = log_directory;
    hdb_log_file_name = path.parse(log_path).base;

    switch (log_type) {
        case WIN:
            //WINSTON
            if (!win_logger) {
                initWinstonLogger();
                trace(`initialized winston logger writing to ${daily_rotate ? log_directory : log_location}`);
            }
            break;

        case PIN:
            //PINO
            if (!pin_logger) {
                initPinoLogger();
                trace(`initialized pino logger writing to ${log_location}`);
            }
            break;

        default:
            //WINSTON is default
            if (!win_logger) {
                initWinstonLogger();
                trace(`initialized winston logger writing to ${daily_rotate ? log_directory : log_location}`);
            }
            break;
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
                    filename: path.join(log_directory, `%DATE%_${hdb_log_file_name}`),
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

    let boot_props_file_path = path.join(home_dir, terms.HDB_HOME_DIR_NAME, terms.BOOT_PROPS_FILE_NAME);
    // this checks how we used to store the boot props file for older installations.
    if(!fs.existsSync(boot_props_file_path)) {
        boot_props_file_path = path.join(__dirname, '../', 'hdb_boot_properties.file');
    }
    return boot_props_file_path;
}