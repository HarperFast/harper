"use strict"
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
const pino = require('pino');
const fs = require('fs');

// read environment settings to get preferred logger and default log level
const PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));

//Using numbers rather than strings for faster comparison
const WIN = 1;
const PIN = 2;

// read environment settings to get log level
let log_level  = hdb_properties.get('LOG_LEVEL');
let log_type  = hdb_properties.get('LOGGER');
let log_location  = hdb_properties.get('LOG_PATH');

//if log location isn't defined, assume HDB_ROOT/log/hdb_log.log
if(log_location === undefined || log_location === 0 || log_location === null) {
    log_location = (hdb_properties.get('HDB_ROOT') + '/log/hdb_log.log');
}

let pino_write_stream = fs.createWriteStream(log_location, {'flags': 'a'});

//  RFC5424: severity of all levels is assumed to be numerically ascending from most important to least important
const winston_log_levels = {
    fatal: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5
};

const FATAL = 'fatal';
const ERR = 'error';
const WARN = 'warn';
const INFO = 'info';
const DEBUG = 'debug';
const TRACE = 'trace';

//TODO: All of this should be happening in an env variable module (yet to be written).
if(log_level === undefined || log_level === 0 || log_level === null) {
    log_level = ERR;
}

//TODO: All of this should be happening in an env variable module (yet to be written).
if(log_type === undefined || log_type === 0 || log_type === null) {
    log_type = WIN;
}

//TODO: not sure if this set to global is needed or useful.  This should be happening in a module.
global.log_level = log_level;
global.log_location = log_location;

module.exports = {
    trace:trace,
    debug:debug,
    info:info,
    warn:warn,
    error:error,
    fatal:fatal,
    setLogLevel:setLogLevel,
    setLogType:setLogType,
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
    win_logger = new (winston.Logger)({
        transports: [
            new(winston.transports.File)({
                level: log_level,
                filename: log_location,
                handleExceptions: true,
                prettyPrint:true
            })
        ],
        levels: winston_log_levels,
        level: log_level,
        exitOnError:false
    });
}

/**
 * Initialize the Pino logger
 */
function initPinoLogger() {
    pin_logger = pino({
        name: `harperDB`,
        level: log_level,
    },pino_write_stream);
}

/**
 * This helper function will take the log level and message as parameters, and write to the log using
 * the logger configured in the settings file.
 * @param {string} level - The log level this message should be written to
 * @param {String} message - The message to be written to the log
 */
function write_log(level, message) {
    // The properties reader returns an object with a length of 0 if a value isn't found.
    if(log_type === undefined || log_type === 0 || log_type === null) {
        log_type = 1;
    }
    if(level === undefined || level === 0 || level === null) {
        level = ERR;
    }
    switch(log_type) {
        case WIN:
            //WINSTON
            if(win_logger === undefined) {
                initWinstonLogger();
            }
            win_logger.log(level, message);
            break;
        case PIN:
            //PINO
            if(pin_logger === undefined) {
                initPinoLogger();
            }
            pin_logger[level](message);
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
 * @param {string} message- The string message to write to the log
 */
function debug(message) {
    write_log(DEBUG, message);
}

/**
 * Writes a warn message to the log.
 * @param {string} message- The string message to write to the log
 */
function warn(message) {
    write_log(WARN, message);
}

/**
 * Set the log level for the HDB Processes.  Default is error.  Options are trace, debug, info, error, fatal.
 * @param {string} level - The logging level for the HDB processes.
 */
function setLogLevel(level) {
    let log_index = Object.keys(winston_log_levels).indexOf(level);

    if(log_index !== -1) {
        switch(log_type) {
            case WIN:
                //WINSTON
                if(win_logger === undefined) {
                    log_level = level;
                    global.log_level = level;
                    return;
                }
                //Winston is strange, it has a log level at the logger level, the transport level, and each individual transport.
                win_logger.level = level;
                win_logger.transports.level = level;
                win_logger.transports.file.level = level;
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
        }
        log_level = level;
        global.log_level = level;
    } else {
        write_log(ERR, `Log level could not be updated to ${level}, that level is not valid.`);
        return;
    }
}

/**
 * Set the logger type used by the HDB process.
 * @param type = The logger to use.  1 = Winston, 2 = Pino.  Any other values
 * will be ignored with an error logged.
 */
function setLogType(type) {
    if( type > 2 || type < 1) {
        write_log(ERR, `logger type ${type} is invalid`);
        return;
    }
    log_type = type;
}