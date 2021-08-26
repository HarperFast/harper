'use strict';

const winston = require('winston');
const pino = require('pino');
const fs = require('fs');
const moment = require('moment');
const path = require('path');
const util = require('util');
const validator = require('../../validation/readLogValidator');
const PropertiesReader = require('properties-reader');
const os = require('os');
const terms = require('../hdbTerms');

// Set interval that log buffer flushes at.
const LOG_BUFFER_FLUSH_INTERVAL = 5000;
const DATE_FORMAT = 'YYYY-MM-DD';

const NOTIFY = 'notify';
const FATAL = 'fatal';
const ERR = 'error';
const WARN = 'warn';
const INFO = 'info';
const DEBUG = 'debug';
const TRACE = 'trace';

const LOGGER_TYPE = {
    RUN_LOG: "run_log",
    INSTALL_LOG: "install_log",
    HDB_LOG: "hdb_log"
};

const LOGGER_PATH = {
    INSTALL_LOG: "../install_log.log",
    RUN_LOG: "../run_log.log"
};

const CUSTOM_LOG_LEVELS = {
    notify: 70,
    fatal: 60,
    error: 50,
    warn: 40,
    info: 30,
    debug: 20,
    trace: 10
};

const DEFAULT_LOG_FILE_NAME = 'hdb_log.log';

let pino_logger = undefined;
let std_out_logger = undefined;
let std_err_logger = undefined;
let final_logger = undefined;
let log_directory = undefined;
let log_file_name = undefined;
let log_location = undefined;
let daily_rotate = undefined;
let log_to_file = undefined;
let log_to_stdstreams = undefined;
let log_level = undefined;
let log_path = undefined;
let default_log_directory = undefined;
let daily_max = undefined;
let hdb_properties = undefined;
let tomorrows_date = undefined;

/**
 * Immediately invoked function that gets log parameters.
 */
(function loadLogParams() {
    if (hdb_properties === undefined) {
        try {
            const boot_props_file_path = getPropsFilePath();
            hdb_properties = PropertiesReader(boot_props_file_path);
            hdb_properties.append(hdb_properties.get('settings_path'));
            daily_rotate = `${hdb_properties.get('LOG_DAILY_ROTATE')}`.toLowerCase() === 'true';
            daily_max = hdb_properties.get('LOG_MAX_DAILY_FILES');
            log_level = hdb_properties.get('LOG_LEVEL');
            log_path = hdb_properties.get('LOG_PATH');

            log_to_file = hdb_properties.get('LOG_TO_FILE');
            if(log_to_file !== undefined && log_to_file !== null){
                log_to_file = log_to_file.toString().toLowerCase() === 'true';
            }

            log_to_stdstreams = hdb_properties.get('LOG_TO_STDSTREAMS');
            if(log_to_stdstreams !== undefined && log_to_stdstreams !== null){
                log_to_stdstreams = log_to_stdstreams.toString().toLowerCase() === 'true';
            }

            if(log_to_file === false && log_to_stdstreams === false){
                log_to_file = true;
            }

            default_log_directory = hdb_properties.get('HDB_ROOT') + '/log/';

            createLog(log_path);
        } catch(err) {
            // In early stage like install or run, settings file and folder is not available yet so let it takes default settings below
        }
    }
})();

if (log_level === undefined || log_level === 0 || log_level === null) {
    log_level = 'error';
}

if (log_path === undefined || log_path === null) {
    // Location of the run log - the harperdb dir.
    log_location = path.resolve(__dirname, `../../${terms.RUN_LOG}`);
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
    writeLog:writeLog,
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
 * Set a location for the log file to be written.  Will stop writing to any existing logs and start writing to the new location.
 * @param log_location_setting
 */
function createLog(log_location_setting) {
    if (daily_rotate) {
        // If the logs are set to daily rotate we get tomorrows date so that we know when to create a new log file.
        tomorrows_date = moment().utc().set({'hour': 0, 'minute': 0, 'second': 0, 'millisecond': 0}).add(1, 'days').valueOf();
    }

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
                        log_directory = default_log_directory;
                        log_file_name = DEFAULT_LOG_FILE_NAME;
                        log_location = path.join(log_directory, log_file_name);
                        writeLog(INFO, `Attempted to create log directory from settings file but failed.  Using default log path - 'hdb/log/hdb_log.log'`);
                    }
                }
            } else {
                if (fs.existsSync(log_location_setting)) {
                    log_directory = log_location_setting;
                    log_file_name = DEFAULT_LOG_FILE_NAME;
                } else {
                    log_directory = log_location_setting;
                    log_file_name = DEFAULT_LOG_FILE_NAME;
                    try {
                        fs.mkdirSync(log_location_setting,{ recursive: true });
                    } catch(err) {
                        log_directory = default_log_directory;
                        log_location = path.join(log_directory, log_file_name);
                        writeLog(INFO, `Attempted to create log directory from settings file but failed.  Using default log path - 'hdb/log/hdb_log.log'`);
                    }
                }
            }
        } catch(e) {
            log_directory = default_log_directory;
            log_file_name = DEFAULT_LOG_FILE_NAME;
            log_location = path.join(log_directory, log_file_name);
            writeLog(INFO, `Attempted to create log directory from settings file but failed.  Using default log path - 'hdb/log/hdb_log.log'`);
        }
    }

    if (log_location === undefined) {
        log_location = daily_rotate ? path.join(log_directory, `${moment().utc().format(DATE_FORMAT)}_${log_file_name}`) : path.join(log_directory, log_file_name);
    }

    if (!pino_logger) {
        initPinoLogger();
        trace(`Initialized pino logger writing to ${log_location} process pid ${process.pid}`);
    }
}

/**
 * Initialize asynchronous Pino logger
 */
function initPinoLogger() {
    try {
        const pino_args = {
            customLevels: CUSTOM_LOG_LEVELS,
            useOnlyCustomLevels:true,
            level: log_level,
            name: 'HarperDB',
            messageKey: 'message',
            timestamp: () => `,"timestamp":"${new Date(Date.now()).toISOString()}"`,
            formatters: {
                bindings() {
                    return undefined; // Removes pid and hostname from log
                },
                level (label) {
                    return { level: label };
                }
            },
        };

        pino_logger = pino(pino_args,
            pino.destination(
                {
                    dest: log_location,
                    minLength: 4096, // Buffer before writing
                    sync: false // Asynchronous logging
                }
            ));

        // asynchronously flush every to keep the buffer empty
        // in periods of low activity
        setInterval(function () {
            if (pino_logger !== undefined) pino_logger.flush();
        }, LOG_BUFFER_FLUSH_INTERVAL).unref();

        final_logger = pino.final(pino_logger);

        std_out_logger = pino(pino_args);
        std_err_logger = pino(pino_args, process.stderr);
    } catch(err) {
        console.error(err);
        throw err;
    }
}

/**
 * final log is a specialist logger that synchronously flushes on every write
 * @returns {undefined|*|(function(*=, ...[*]): *)}
 */
function writeToFinalLog(level, message) {
    if (pino_logger === undefined) {
        initPinoLogger();
    }

    if (final_logger === undefined) {
        final_logger = pino.final(pino_logger);
    }

    if (log_to_file) {
        final_logger[level](message);
    }

    if (log_to_stdstreams) {
        logToStdStream(level, message);
    }
}

/**
 * This helper function will take the log level and message as parameters, and write to the log using
 * the logger configured in the settings file.
 * @param {string|number|null} level - The log level this message should be written to
 * @param {String} message - The message to be written to the log
 */
function writeLog(level, message) {
    try {
        if (level === undefined || level === 0 || level === null) {
            level = 'error';
        }

        if (!pino_logger) {
            initPinoLogger();
            trace(`Initialized pino logger writing to ${log_location} process pid ${process.pid}`);
        }

        // Daily rotate is set in HDB config
        if (daily_rotate && (Date.now() > tomorrows_date)) {
            // Anything in the the current logs buffer is flushed to the log file.
            if (pino_logger) {
                pino_logger.flush();
            }

            // Update the tomorrow date value
            tomorrows_date = moment().utc().set({'hour': 0, 'minute': 0, 'second': 0, 'millisecond': 0}).add(1, 'days').valueOf();
            const new_log_location = path.join(log_directory, `${moment().utc().format(DATE_FORMAT)}_${log_file_name}`);

            // Create a new pino logger instance under new file name.
            if (new_log_location !== log_location) {
                log_location = new_log_location;
                initPinoLogger();
                pino_logger.notify(`Initialized pino logger writing to ${log_location} process pid ${process.pid}`);
            }

            // If the config has a value for dail max we must check to see any old logs need to be removed.
            if (Number.isInteger(daily_max) && daily_max > 0) {
                removeOldLogs();
            }
        }

        if(log_to_file === true) {
            pino_logger[level](message);
        }

        logToStdStream(level, message);
    } catch(err) {
        console.error(err);
        throw err;
    }
}

/**
 * logs to stdout / stderr if logging to std streams is enabled
 * @param {string} level - log level
 * @param {string} message - message to log
 */
function logToStdStream(level, message){
    if(log_to_stdstreams !== true) {
        return;
    }

    if(!std_err_logger || !std_out_logger){
        initPinoLogger();
    }

    if(level === FATAL || level === ERR){
        std_err_logger[level](message);
    } else{
        std_out_logger[level](message);
    }
}

/**
 * Gets all the log files in the log dir and extracts the date from the file names.
 * From there it will remove the oldest log if the total number of logs is greater than daily max.
 */
function removeOldLogs() {
    const all_log_files = fs.readdirSync(log_directory, { withFileTypes: true });
    let all_valid_dates = [];
    const array_length = all_log_files.length;
    for (let x = 0; x < array_length; x++) {
        const file_name = all_log_files[x].name;
        const log_date = file_name.split('_')[0];

        // If the file has a .log extension and a valid date at the beginning of its name push it to array.
        if (path.extname(file_name) === '.log' && moment(log_date, DATE_FORMAT, true).isValid()) {
            all_valid_dates.push({ date: log_date, file_name });
        }
    }

    if (all_valid_dates.length > daily_max) {
        // Sort array of log file dates so that we know the oldest log.
        const sorted_dates = all_valid_dates.sort((a, b) => moment(a.date, DATE_FORMAT, true) - moment(b.date, DATE_FORMAT, true));
        // Oldest log will be the one at the start of array.
        const log_to_remove = sorted_dates[0].file_name;
        fs.unlinkSync(path.join(log_directory, log_to_remove));
        pino_logger.info(`${log_to_remove} deleted`);
    }
}

/**
 * Writes a info message to the log.
 * @param {string} message - The string message to write to the log
 * @param {boolean} final_log - Write to final_log
 */
function info(message, final_log = false) {
    if (final_log) {
        writeToFinalLog(INFO, message);
    } else {
        writeLog(INFO, message);
    }
}

/**
 * Writes a trace message to the log.
 * @param {string} message - The string message to write to the log
 * @param {boolean} final_log - Write to final_log
 */
function trace(message, final_log = false) {
    if (final_log) {
        writeToFinalLog(TRACE, message);
    } else {
        writeLog(TRACE, message);
    }
}

/**
 * Writes a error message to the log.
 * @param {string} message - The string message to write to the log
 * @param {boolean} final_log - Write to final_log
 */
function error(message, final_log= false) {
    if (final_log) {
        writeToFinalLog(ERR, message);
    } else {
        writeLog(ERR, message);
    }
}

/**
 * Writes a fatal message to the log.
 * @param {string} message - The string message to write to the log
 * @param {boolean} final_log - Write to final_log
 */
function fatal(message, final_log= false) {
    if (final_log) {
        writeToFinalLog(FATAL, message);
    } else {
        writeLog(FATAL, message);
    }
}

/**
 * Writes a debug message to the log.
 * @param {string} message - The string message to write to the log
 * @param {boolean} final_log - Write to final_log
 */
function debug(message, final_log = false) {
    if (final_log) {
        writeToFinalLog(DEBUG, message);
    } else {
        writeLog(DEBUG, message);
    }
}

/**
 * Writes a warn message to the log.
 * @param {string} message - The string message to write to the log
 * @param {boolean} final_log - Write to final_log
 */
function warn(message, final_log= false) {
    if (final_log) {
        writeToFinalLog(WARN, message);
    } else {
        writeLog(WARN, message);
    }
}

/**
 * Writes a notify message to the log.
 * @param {string} message - The string message to write to the log
 * @param {boolean} final_log - Write to final_log
 */
function notify(message, final_log= false) {
    if (final_log) {
        writeToFinalLog(NOTIFY, message);
    } else {
        writeLog(NOTIFY, message);
    }
}

/**
 * Set the log level for the HDB Processes.  Default is error.  Options are trace, debug, info, error, fatal.
 * @param {string} level - The logging level for the HDB processes.
 */
function setLogLevel(level) {
    if(pino_logger === undefined) {
        log_level = level;
        return;
    }

    pino_logger.level = level;
    log_level = level;
}

async function readLog(read_log_object) {
    const validation = validator(read_log_object);
    if (validation) {
        throw validation;
    }

    const options = {
        limit: 100,
        fields: ['level','message','timestamp'],
        // Winston adds a default 'from' value if one is not passed. The default is one day from today, this is silly so we
        // override it. If a 'from' date is included in the request it will be added below.
        from: new Date('1970-01-01T00:00:00')
    };

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

/**
 * Winston is used to query the Pino log.
 * @param query_log_path
 */
function configureWinstonForQuery(query_log_path) {
    const query_path = query_log_path ? query_log_path : log_location;
    winston.configure({
        transports: [
            new (winston.transports.File)({
                filename: query_path
            })
        ],
        exitOnError: false
    });
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
