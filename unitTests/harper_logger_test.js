"use strict";
/**
 * Tests the harper logger module.  Note the following variables are required in the settings file:
 *
 * LOG_LEVEL = trace
 * LOGGER = 1
 * LOG_PATH = /Users/elipalmer/harperdb/unitTests/testlog.log
 */

const assert = require('assert');
let sinon = require('sinon');
let fs = require('fs');
let harper_log = require('../utility/logging/harper_logger.js');

let output_file_name = global.log_location;
let file_change_results = false;

const LOG_DELIMITER = '______________';

const FATAL_LOG_MESSAGE = 'FATAL_MSG';
const ERROR_LOG_MESSAGE = 'ERROR_MSG';
const WARN_LOG_MESSAGE = 'WARN_MSG';
const INFO_LOG_MESSAGE = 'INFO_MSG';
const DEBUG_LOG_MESSAGE = 'DEBUG_MSG';
const TRACE_LOG_MESSAGE = 'TRACE_MSG';

let harper_debug_spy = undefined;
let harper_trace_spy = undefined;
let harper_error_spy = undefined;
let harper_info_spy = undefined;
let harper_warn_spy = undefined;
let harper_fatal_spy = undefined;

let watcher = undefined;

const WINSTON = 1;
const PINO = 2;

const ZEROIZE_OUTPUT_FILE = true;

function printLogs() {
    harper_log.fatal(FATAL_LOG_MESSAGE);
    harper_log.info(INFO_LOG_MESSAGE);
    harper_log.debug(DEBUG_LOG_MESSAGE);
    harper_log.error(ERROR_LOG_MESSAGE);
    harper_log.warn(WARN_LOG_MESSAGE);
    harper_log.trace(TRACE_LOG_MESSAGE);
}

function zeroizeOutputFile() {
    if(ZEROIZE_OUTPUT_FILE) {
        fs.truncate(output_file_name, 0, function () {
            //no-op
        });
    }
}

function log_something(level, done) {
    harper_log.setLogLevel(level);
    harper_log.fatal(LOG_DELIMITER+level);
    printLogs();
    harper_log.fatal(LOG_DELIMITER+level);
    setTimeout( function () {
        fs.readFile(output_file_name, function read(err, data) {
            if(err) {
                console.log('ERROR!');
                throw err;
            }
            let start_index = data.indexOf(LOG_DELIMITER+level);
            let end_index = data.lastIndexOf(LOG_DELIMITER+level);
            let logged_message = data.slice(start_index, end_index);
            assert.notEqual(-1, end_index, 'last message delimiter not found');
            assert.notEqual(-1, start_index, 'first message delimiter not found');
            assert.ok(end_index > start_index);
            switch(level) {
                case 'trace':
                    assert.notEqual(-1, logged_message.indexOf(FATAL_LOG_MESSAGE), 'Did not find fatal message');
                    assert.notEqual(-1, logged_message.indexOf(TRACE_LOG_MESSAGE), 'Did not find trace message');
                    assert.notEqual(-1, logged_message.indexOf(INFO_LOG_MESSAGE), 'Did not find info message');
                    assert.notEqual(-1, logged_message.indexOf(DEBUG_LOG_MESSAGE), 'Did not find debug message');
                    assert.notEqual(-1, logged_message.indexOf(WARN_LOG_MESSAGE), 'Did not find warn message');
                    assert.notEqual(-1, logged_message.indexOf(ERROR_LOG_MESSAGE),'Did not find error message');
                    break;
                case 'debug':
                    assert.notEqual(-1, logged_message.indexOf(FATAL_LOG_MESSAGE), 'Did not find fatal message');
                    assert.equal(-1, logged_message.indexOf(TRACE_LOG_MESSAGE));
                    assert.notEqual(-1, logged_message.indexOf(INFO_LOG_MESSAGE), 'Did not find info message');
                    assert.notEqual(-1, logged_message.indexOf(DEBUG_LOG_MESSAGE), 'Did not find debug message');
                    assert.notEqual(-1, logged_message.indexOf(WARN_LOG_MESSAGE), 'Did not find warn message');
                    assert.notEqual(-1, logged_message.indexOf(ERROR_LOG_MESSAGE),'Did not find error message');
                    break;
                case 'info':
                    assert.notEqual(-1, logged_message.indexOf(FATAL_LOG_MESSAGE), 'Did not find fatal message');
                    assert.equal(-1, logged_message.indexOf(TRACE_LOG_MESSAGE));
                    assert.notEqual(-1, logged_message.indexOf(INFO_LOG_MESSAGE), 'Did not find info message');
                    assert.equal(-1, logged_message.indexOf(DEBUG_LOG_MESSAGE));
                    assert.notEqual(-1, logged_message.indexOf(WARN_LOG_MESSAGE), 'Did not find warn message');
                    assert.notEqual(-1, logged_message.indexOf(ERROR_LOG_MESSAGE),'Did not find error message');
                    break;
                case 'warn':
                    assert.notEqual(-1, logged_message.indexOf(FATAL_LOG_MESSAGE), 'Did not find fatal message');
                    assert.equal(-1, logged_message.indexOf(TRACE_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(INFO_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(DEBUG_LOG_MESSAGE));
                    assert.notEqual(-1, logged_message.indexOf(WARN_LOG_MESSAGE), 'Did not find warn message');
                    assert.notEqual(-1, logged_message.indexOf(ERROR_LOG_MESSAGE),'Did not find error message');
                    break;
                case 'error':
                    assert.notEqual(-1, logged_message.indexOf(FATAL_LOG_MESSAGE), 'Did not find fatal message');
                    assert.equal(-1, logged_message.indexOf(TRACE_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(INFO_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(DEBUG_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(WARN_LOG_MESSAGE));
                    assert.notEqual(-1, logged_message.indexOf(ERROR_LOG_MESSAGE),'Did not find error message');
                    break;
                case 'fatal':
                    assert.notEqual(-1, logged_message.indexOf(FATAL_LOG_MESSAGE), 'Did not find fatal message');
                    assert.equal(-1, logged_message.indexOf(TRACE_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(INFO_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(DEBUG_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(WARN_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(ERROR_LOG_MESSAGE));
                    break;
            }
            done();
        });
    }, 100);
};

// NOTES
/*
    Mocha is not very good at test reuse.  Even though the tests are the same for both
    WINSTON and PINO, I noticed that when I wrapped the tests below in a function and calling them,
    the would ingore the logger setting and just use the second logger set (in this case, PINO), so
    the first logger was never being tested.

    This is why we have duplicate blocks of the same tests for Winston and Pino.  Shared behavior should
    work, but I could never get it to behave.

    https://github.com/mochajs/mocha/wiki/Shared-Behaviours

    You can check that both loggers are being exercised by setting ZEROIZE_OUTPUT_FILE to false and then
    eyeballing the output file.  You should see distinct signatures from both loggers.  Note this should cause
    the tests to fail since logs will exist that shouldn't due to the log level, but it's an easy solution to check
    both loggers are being used.
 */

describe(`Test log writing - Winston`, function() {
    before( function() {
        file_change_results = false;
        harper_log.setLogType(WINSTON);
        if(!fs.existsSync(output_file_name)) {
            try {
                fs.writeFileSync(output_file_name, '');
            } catch (e) {
                console.log("Cannot write file ", e);
            }
        }

        watcher = fs.watch(output_file_name, {persistent: false}, (eventType, filename) => {
            if(filename) {
                file_change_results = true;
            } else {
                console.log(`filename not found`);
            }
        });
    });
    beforeEach( function() {
        file_change_results = false;
    });
    after(function() {
        zeroizeOutputFile();
        watcher.close();
    });
    it('Test Trace Level', function(done) {
        if(harper_trace_spy === undefined) {
            harper_trace_spy = sinon.spy(harper_log, 'trace');
        }
        harper_log.setLogLevel(harper_log.TRACE);
        harper_log.trace(TRACE_LOG_MESSAGE);

        assert.equal(harper_trace_spy.called,true, "logger 'trace' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling trace.");
            done();
        }, 100);
    });
    it('Test Debug Level', function(done) {
        file_change_results = false;
        if( harper_debug_spy === undefined) {
            harper_debug_spy = sinon.spy(harper_log, 'debug');
        }
        harper_log.setLogLevel(harper_log.DEBUG);
        harper_log.debug(DEBUG_LOG_MESSAGE);

        assert.equal(harper_debug_spy.called,true, "logger 'debug' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling debug.");
            done();
        }, 100);
    });
    it('Test Info Level', function(done) {
        file_change_results = false;
        if( harper_info_spy === undefined) {
            harper_info_spy = sinon.spy(harper_log, 'info');
        }
        harper_log.setLogLevel(harper_log.INFO);
        harper_log.info(INFO_LOG_MESSAGE);

        assert.equal(harper_info_spy.called,true, "logger 'info' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling info.");
            done();
        }, 100);
    });
    it('Test Warn Level', function(done) {
        file_change_results = false;
        if( harper_warn_spy === undefined) {
            harper_warn_spy = sinon.spy(harper_log, 'warn');
        }
        harper_log.setLogLevel(harper_log.WARN);
        harper_log.warn(WARN_LOG_MESSAGE);

        assert.equal(harper_warn_spy.called,true, "logger 'warn' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling warn.");
            done();
        }, 100);
    });
    it('Test Error Level', function(done) {
        file_change_results = false;
        if( harper_error_spy === undefined) {
            harper_error_spy = sinon.spy(harper_log, 'error');
        }
        harper_log.setLogLevel(harper_log.ERR);
        harper_log.error(ERROR_LOG_MESSAGE);

        assert.equal(harper_error_spy.called,true, "logger 'error' function was not called.");

        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling error.");
            done();
        }, 100);
    });
    it('Test Fatal Level', function(done) {
        file_change_results = false;
        if( harper_fatal_spy === undefined) {
            harper_fatal_spy = sinon.spy(harper_log, 'fatal');
        }
        harper_log.setLogLevel(harper_log.FATAL);
        harper_log.fatal(FATAL_LOG_MESSAGE);

        assert.equal(harper_fatal_spy.called,true, "logger 'fatal' function was not called.");

        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling fatal.");
            done();
        }, 100);
    });
});

describe(`Test log writing - PINO`, function() {
    before( function() {
        file_change_results = false;
        harper_log.setLogType(PINO);
        if(!fs.existsSync(output_file_name)) {
            try {
                fs.writeFileSync(output_file_name, '');
            } catch (e) {
                console.log("Cannot write file ", e);
            }
        }

        watcher = fs.watch(output_file_name, {persistent: false}, (eventType, filename) => {
            if(filename) {
                file_change_results = true;
            } else {
                console.log(`filename not found`);
            }
        });
    });
    beforeEach( function() {
        file_change_results = false;
    });
    after(function() {
        zeroizeOutputFile();
        watcher.close();
    });
    it('Test Trace Level', function(done) {
        if(harper_trace_spy === undefined) {
            harper_trace_spy = sinon.spy(harper_log, 'trace');
        }
        harper_log.setLogLevel(harper_log.TRACE);
        harper_log.trace(TRACE_LOG_MESSAGE);
        assert.equal(harper_trace_spy.called,true, "logger 'trace' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling trace.");
            done();
        }, 100);
    });
    it('Test Debug Level', function(done) {
        file_change_results = false;
        if( harper_debug_spy === undefined) {
            harper_debug_spy = sinon.spy(harper_log, 'debug');
        }
        harper_log.setLogLevel(harper_log.DEBUG);
        harper_log.debug(DEBUG_LOG_MESSAGE);
        assert.equal(harper_debug_spy.called,true, "logger 'debug' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling debug.");
            done();
        }, 100);
    });
    it('Test Info Level', function(done) {
        file_change_results = false;
        if( harper_info_spy === undefined) {
            harper_info_spy = sinon.spy(harper_log, 'info');
        }
        harper_log.setLogLevel(harper_log.INFO);
        harper_log.info(INFO_LOG_MESSAGE);
        assert.equal(harper_info_spy.called,true, "logger 'info' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling info.");
            done();
        }, 100);
    });
    it('Test Warn Level', function(done) {
        file_change_results = false;
        if( harper_warn_spy === undefined) {
            harper_warn_spy = sinon.spy(harper_log, 'warn');
        }
        harper_log.setLogLevel(harper_log.WARN);
        harper_log.warn(WARN_LOG_MESSAGE);
        assert.equal(harper_warn_spy.called,true, "logger 'warn' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling warn.");
            done();
        }, 100);
    });
    it('Test Error Level', function(done) {
        file_change_results = false;
        if( harper_error_spy === undefined) {
            harper_error_spy = sinon.spy(harper_log, 'error');
        }
        harper_log.setLogLevel(harper_log.ERR);
        harper_log.error(ERROR_LOG_MESSAGE);
        assert.equal(harper_error_spy.called,true, "logger 'error' function was not called.");

        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling error.");
            done();
        }, 100);
    });
    it('Test Fatal Level', function(done) {
        file_change_results = false;
        if( harper_fatal_spy === undefined) {
            harper_fatal_spy = sinon.spy(harper_log, 'fatal');
        }
        harper_log.setLogLevel(harper_log.FATAL);
        harper_log.fatal(FATAL_LOG_MESSAGE);
        assert.equal(harper_fatal_spy.called,true, "logger 'fatal' function was not called.");

        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling fatal.");
            done();
        }, 100);
    });
});

describe(`Test log level writing - WINSTON`, function(done) {
    before(function () {
        harper_log.setLogType(WINSTON);
    });
    after(function () {
        zeroizeOutputFile();
    });
    it('Set log level to fatal, should only see fatal message', function (done) {
        log_something(harper_log.FATAL, done);
    });
    it('Set log level to error, should only see error and fatal message', function (done) {
        log_something(harper_log.ERR, done);
    });
    it('Set log level to warn, should only see error, fatal, warn message', function (done) {
        log_something(harper_log.WARN, done);
    });
    it('Set log level to info, should see error, fatal, warn, info message', function (done) {
        log_something(harper_log.INFO, done);
    });
    it('Set log level to debug, should see all but trace', function (done) {
        log_something(harper_log.DEBUG, done);
    });
    it('Set log level to trace, should see all messages', function (done) {
        log_something(harper_log.TRACE, done);
    });
});
describe(`Test log level writing - PINO`, function (done) {
    before(function () {
        harper_log.setLogType(PINO);
    });
    after(function () {
        zeroizeOutputFile();
    });
    it('Set log level to fatal, should only see fatal message', function (done) {
        log_something(harper_log.FATAL, done);
    });
    it('Set log level to error, should only see error and fatal message', function (done) {
        log_something(harper_log.ERR, done);
    });
    it('Set log level to warn, should only see error, fatal, warn message', function (done) {
        log_something(harper_log.WARN, done);
    });
    it('Set log level to info, should see error, fatal, warn, info message', function (done) {
        log_something(harper_log.INFO, done);
    });
    it('Set log level to debug, should see all but trace', function (done) {
        log_something(harper_log.DEBUG, done);
    });
    it('Set log level to trace, should see all messages', function (done) {
        log_something(harper_log.TRACE, done);
    });
});

describe(`Test setLogType`, function (done) {
    before(function () {
        harper_log.setLogType(WINSTON);
        file_change_results = false;
        watcher = fs.watch(output_file_name, {persistent: false}, (eventType, filename) => {
            if(filename) {
                file_change_results = true;
            } else {
                console.log(`filename not found`);
            }
        });
    });
    after(function () {
        zeroizeOutputFile();
    });
    it('Pass in empty value, expect error written in log.', function (done) {
        harper_log.setLogType('');
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change passing bad argument to setLogType.");
            done();
        }, 100);
    });
    it('Pass invalid value, expect error written in log.', function (done) {
        harper_log.setLogType(12);
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change passing bad argument to setLogType.");
            done();
        }, 100);
    });
});
