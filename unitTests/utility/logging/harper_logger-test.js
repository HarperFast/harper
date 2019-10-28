"use strict";
/**
 * Tests the harper logger module.  Note the following variables are required in the settings file:
 *
 * LOG_LEVEL = trace
 * LOGGER = 1
 * LOG_PATH = /Users/elipalmer/harperdb/unitTests/testlog.log
 */
const test_utils = require('../../test_utils');
test_utils.preTestPrep();
const assert = require('assert');
const chai = require('chai');
const sinon_chai = require('sinon-chai');
const expect = chai.expect;
chai.use(sinon_chai);
const sinon = require('sinon');
const fs = require('fs');
const moment = require('moment');
const winston = require('winston');
const path = require('path');

const rewire = require('rewire');
let harper_log = rewire('../../../utility/logging/harper_logger');

const default_test_log_dir = path.join(process.cwd(), "../", "unitTests");
const default_test_log_name = 'test_log.log';
const default_test_log_path = path.join(default_test_log_dir, default_test_log_name);
// Create log location for Winston daily rotation file tests
let current_date = moment().format("YYYY-MM-DD");
let daily_file_name = `${current_date}_${default_test_log_name}`;
let daily_test_log_path = path.join(default_test_log_dir, daily_file_name);
let file_change_results = false;

// Create variable to use for watchers and for ensuring test logs are cleaned up after testing
let output_file_path;

const LOG_DELIMITER = '______________';

const NOTIFY_LOG_MESSAGE = 'NOTIFY_MSG';
const FATAL_LOG_MESSAGE = 'FATAL_MSG';
const ERROR_LOG_MESSAGE = 'ERROR_MSG';
const WARN_LOG_MESSAGE = 'WARN_MSG';
const INFO_LOG_MESSAGE = 'INFO_MSG';
const DEBUG_LOG_MESSAGE = 'DEBUG_MSG';
const TRACE_LOG_MESSAGE = 'TRACE_MSG';

let harper_notify_spy = undefined;
let harper_debug_spy = undefined;
let harper_trace_spy = undefined;
let harper_error_spy = undefined;
let harper_info_spy = undefined;
let harper_warn_spy = undefined;
let harper_fatal_spy = undefined;

const sandbox = sinon.createSandbox();

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
    harper_log.notify(NOTIFY_LOG_MESSAGE);
}

function zeroizeOutputFile() {
    if (ZEROIZE_OUTPUT_FILE) {
        fs.truncateSync(output_file_path, 0);
    }
}

function rewireDefaultLogger(log_type) {
    const test_log_type = log_type ? log_type : WINSTON;
    harper_log = rewire('../../../utility/logging/harper_logger');
    harper_log.__set__("log_type", test_log_type);
    harper_log.__set__("log_location", default_test_log_path);
    harper_log.__set__("daily_rotate", undefined);
}

function rewireDailyLogger() {
    harper_log = rewire('../../../utility/logging/harper_logger');
    harper_log.__set__("log_type", WINSTON);
    harper_log.__set__("log_location", default_test_log_path);
    harper_log.__set__("log_directory", default_test_log_dir);
    harper_log.__set__("hdb_log_file_name", default_test_log_name);
    harper_log.__set__("daily_rotate", true);
}

function resetLoggerSpies() {
    harper_trace_spy = sandbox.spy(harper_log, 'trace');
    harper_debug_spy = sandbox.spy(harper_log, 'debug');
    harper_info_spy = sandbox.spy(harper_log, 'info');
    harper_warn_spy = sandbox.spy(harper_log, 'warn');
    harper_error_spy = sandbox.spy(harper_log, 'error');
    harper_fatal_spy = sandbox.spy(harper_log, 'fatal');
    harper_notify_spy = sandbox.spy(harper_log, 'notify');
}

function unlinkTestLog(path) {
    if (fs.existsSync(path)) {
        fs.unlinkSync(path);
    }
}

function log_something(level, done) {
    harper_log.setLogLevel(level);
    harper_log.notify(LOG_DELIMITER+level);
    printLogs();
    harper_log.notify(LOG_DELIMITER+level);
    setTimeout(() => {
        fs.readFile(output_file_path, function read(err, data) {
            if(err) {
                console.log('ERROR!');
                throw err;
            }
            let start_index = data.indexOf(LOG_DELIMITER+level);
            let end_index = data.lastIndexOf(LOG_DELIMITER+level);
            let logged_message = data.slice(start_index, end_index);

            // TODO: Update tests below to use Chai assertions AND ensure that expected and actual values are entered in the correct place of the Chai.expect
            assert.notEqual(-1, end_index, 'last message delimiter not found');
            assert.notEqual(-1, start_index, 'first message delimiter not found');
            assert.ok(end_index > start_index);
            switch(level) {
                case 'trace':
                    assert.notEqual(-1, logged_message.indexOf(NOTIFY_LOG_MESSAGE), 'Did not find notify message');
                    assert.notEqual(-1, logged_message.indexOf(FATAL_LOG_MESSAGE), 'Did not find fatal message');
                    assert.notEqual(-1, logged_message.indexOf(TRACE_LOG_MESSAGE), 'Did not find trace message');
                    assert.notEqual(-1, logged_message.indexOf(INFO_LOG_MESSAGE), 'Did not find info message');
                    assert.notEqual(-1, logged_message.indexOf(DEBUG_LOG_MESSAGE), 'Did not find debug message');
                    assert.notEqual(-1, logged_message.indexOf(WARN_LOG_MESSAGE), 'Did not find warn message');
                    assert.notEqual(-1, logged_message.indexOf(ERROR_LOG_MESSAGE),'Did not find error message');
                    break;
                case 'debug':
                    assert.notEqual(-1, logged_message.indexOf(NOTIFY_LOG_MESSAGE), 'Did not find notify message');
                    assert.notEqual(-1, logged_message.indexOf(FATAL_LOG_MESSAGE), 'Did not find fatal message');
                    assert.equal(-1, logged_message.indexOf(TRACE_LOG_MESSAGE));
                    assert.notEqual(-1, logged_message.indexOf(INFO_LOG_MESSAGE), 'Did not find info message');
                    assert.notEqual(-1, logged_message.indexOf(DEBUG_LOG_MESSAGE), 'Did not find debug message');
                    assert.notEqual(-1, logged_message.indexOf(WARN_LOG_MESSAGE), 'Did not find warn message');
                    assert.notEqual(-1, logged_message.indexOf(ERROR_LOG_MESSAGE),'Did not find error message');
                    break;
                case 'info':
                    assert.notEqual(-1, logged_message.indexOf(NOTIFY_LOG_MESSAGE), 'Did not find notify message');
                    assert.notEqual(-1, logged_message.indexOf(FATAL_LOG_MESSAGE), 'Did not find fatal message');
                    assert.equal(-1, logged_message.indexOf(TRACE_LOG_MESSAGE));
                    assert.notEqual(-1, logged_message.indexOf(INFO_LOG_MESSAGE), 'Did not find info message');
                    assert.equal(-1, logged_message.indexOf(DEBUG_LOG_MESSAGE));
                    assert.notEqual(-1, logged_message.indexOf(WARN_LOG_MESSAGE), 'Did not find warn message');
                    assert.notEqual(-1, logged_message.indexOf(ERROR_LOG_MESSAGE),'Did not find error message');
                    break;
                case 'warn':
                    assert.notEqual(-1, logged_message.indexOf(NOTIFY_LOG_MESSAGE), 'Did not find notify message');
                    assert.notEqual(-1, logged_message.indexOf(FATAL_LOG_MESSAGE), 'Did not find fatal message');
                    assert.equal(-1, logged_message.indexOf(TRACE_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(INFO_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(DEBUG_LOG_MESSAGE));
                    assert.notEqual(-1, logged_message.indexOf(WARN_LOG_MESSAGE), 'Did not find warn message');
                    assert.notEqual(-1, logged_message.indexOf(ERROR_LOG_MESSAGE),'Did not find error message');
                    break;
                case 'error':
                    assert.notEqual(-1, logged_message.indexOf(NOTIFY_LOG_MESSAGE), 'Did not find notify message');
                    assert.notEqual(-1, logged_message.indexOf(FATAL_LOG_MESSAGE), 'Did not find fatal message');
                    assert.equal(-1, logged_message.indexOf(TRACE_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(INFO_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(DEBUG_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(WARN_LOG_MESSAGE));
                    assert.notEqual(-1, logged_message.indexOf(ERROR_LOG_MESSAGE),'Did not find error message');
                    break;
                case 'fatal':
                    assert.notEqual(-1, logged_message.indexOf(NOTIFY_LOG_MESSAGE), 'Did not find notify message');
                    assert.notEqual(-1, logged_message.indexOf(FATAL_LOG_MESSAGE), 'Did not find fatal message');
                    assert.equal(-1, logged_message.indexOf(TRACE_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(INFO_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(DEBUG_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(WARN_LOG_MESSAGE));
                    assert.equal(-1, logged_message.indexOf(ERROR_LOG_MESSAGE));
                    break;
                case 'notify':
                    assert.notEqual(-1, logged_message.indexOf(NOTIFY_LOG_MESSAGE), 'Did not find notify message');
                    assert.equal(-1, logged_message.indexOf(FATAL_LOG_MESSAGE));
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
}

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

describe('Test harper_logger ', () => {
    after((done) => {
        sandbox.restore();
        rewireDefaultLogger();
        setTimeout(() => {
            unlinkTestLog(default_test_log_path);
            unlinkTestLog(daily_test_log_path);
            done();
        }, 200);
    });

    describe(`Test log writing - Winston`, () => {
        before(() => {
            rewireDefaultLogger();
            resetLoggerSpies();
            output_file_path = default_test_log_path;
            file_change_results = false;
            harper_log.setLogType(WINSTON);
            if (!fs.existsSync(output_file_path)) {
                try {
                    fs.writeFileSync(output_file_path, '');
                } catch (e) {
                    console.log("Cannot write file ", e);
                }
            }

            watcher = fs.watch(output_file_path, {persistent: false}, (eventType, filename) => {
                if (filename) {
                    file_change_results = true;
                } else {
                    console.log(`filename not found`);
                }
            });
        });

        beforeEach(() => {
            file_change_results = false;
        });

        after(() => {
            zeroizeOutputFile();
            watcher.close();
        });

        it('Test Trace Level', (done) => {
            harper_log.setLogLevel(harper_log.TRACE);
            harper_log.trace(TRACE_LOG_MESSAGE);

            assert.equal(harper_trace_spy.calledOnce,true, "logger 'trace' function was not called.");
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling trace.");
                done();
            }, 100);
        });
        it('Test Debug Level', (done) => {
            harper_log.setLogLevel(harper_log.DEBUG);
            harper_log.debug(DEBUG_LOG_MESSAGE);

            assert.equal(harper_debug_spy.calledOnce,true, "logger 'debug' function was not called.");
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling debug.");
                done();
            }, 100);
        });
        it('Test Info Level', (done) => {
            harper_log.setLogLevel(harper_log.INFO);
            harper_log.info(INFO_LOG_MESSAGE);

            assert.equal(harper_info_spy.calledOnce,true, "logger 'info' function was not called.");
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling info.");
                done();
            }, 100);
        });
        it('Test Warn Level', (done) => {
            harper_log.setLogLevel(harper_log.WARN);
            harper_log.warn(WARN_LOG_MESSAGE);

            assert.equal(harper_warn_spy.calledOnce,true, "logger 'warn' function was not called.");
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling warn.");
                done();
            }, 100);
        });
        it('Test Error Level', (done) => {
            harper_log.setLogLevel(harper_log.ERR);
            harper_log.error(ERROR_LOG_MESSAGE);

            assert.equal(harper_error_spy.calledOnce,true, "logger 'error' function was not called.");

            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling error.");
                done();
            }, 100);
        });
        it('Test Fatal Level', (done) => {
            harper_log.setLogLevel(harper_log.FATAL);
            harper_log.fatal(FATAL_LOG_MESSAGE);

            assert.equal(harper_fatal_spy.calledOnce,true, "logger 'fatal' function was not called.");

            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling fatal.");
                done();
            }, 100);
        });

        it('Test Notify Level', (done) => {
            harper_log.setLogLevel(harper_log.NOTIFY);
            harper_log.notify(NOTIFY_LOG_MESSAGE);
            assert.equal(harper_notify_spy.calledOnce,true, "logger 'notify' function was not called.");

            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling fatal.");
                done();
            }, 100);
        });
    });

    describe(`Test log writing - WINSTON w/ Daily File Rotation`, () => {
        before(() => {
            rewireDailyLogger();
            resetLoggerSpies();
            output_file_path = daily_test_log_path;
            if (!fs.existsSync(output_file_path)) {
                try {
                    fs.writeFileSync(output_file_path, '');
                } catch (e) {
                    console.log("Cannot write file ", e);
                }
            }

            watcher = fs.watch(output_file_path, {persistent: false}, (eventType, filename) => {
                if (filename) {
                    file_change_results = true;
                } else {
                    console.log(`filename not found`);
                }
            });
        });

        beforeEach(() => {
            file_change_results = false;
        });

        after(() => {
            zeroizeOutputFile();
            watcher.close();
            sandbox.resetHistory();
        });

        it('Test Trace Level', (done) => {
            harper_log.setLogLevel(harper_log.TRACE);
            harper_log.trace(TRACE_LOG_MESSAGE);

            assert.equal(harper_trace_spy.calledOnce,true, "logger 'trace' function was not called.");
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling trace.");
                done();
            }, 100);
        });
        it('Test Debug Level', (done) => {
            harper_log.setLogLevel(harper_log.DEBUG);
            harper_log.debug(DEBUG_LOG_MESSAGE);

            assert.equal(harper_debug_spy.calledOnce,true, "logger 'debug' function was not called.");
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling debug.");
                done();
            }, 100);
        });
        it('Test Info Level', (done) => {
            harper_log.setLogLevel(harper_log.INFO);
            harper_log.info(INFO_LOG_MESSAGE);

            assert.equal(harper_info_spy.calledOnce,true, "logger 'info' function was not called.");
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling info.");
                done();
            }, 100);
        });
        it('Test Warn Level', (done) => {
            harper_log.setLogLevel(harper_log.WARN);
            harper_log.warn(WARN_LOG_MESSAGE);

            assert.equal(harper_warn_spy.calledOnce,true, "logger 'warn' function was not called.");
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling warn.");
                done();
            }, 100);
        });
        it('Test Error Level', (done) => {
            harper_log.setLogLevel(harper_log.ERR);
            harper_log.error(ERROR_LOG_MESSAGE);

            assert.equal(harper_error_spy.calledOnce,true, "logger 'error' function was not called.");

            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling error.");
                done();
            }, 100);
        });
        it('Test Fatal Level', (done) => {
            harper_log.setLogLevel(harper_log.FATAL);
            harper_log.fatal(FATAL_LOG_MESSAGE);

            assert.equal(harper_fatal_spy.calledOnce,true, "logger 'fatal' function was not called.");

            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling fatal.");
                done();
            }, 100);
        });

        it('Test Notify Level', (done) => {
            harper_log.setLogLevel(harper_log.NOTIFY);
            harper_log.notify(NOTIFY_LOG_MESSAGE);
            assert.equal(harper_notify_spy.calledOnce,true, "logger 'notify' function was not called.");

            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling fatal.");
                done();
            }, 100);
        });
    });

    describe(`Test log writing - PINO`, () => {
        before(() => {
            rewireDefaultLogger(PINO);
            resetLoggerSpies();
            output_file_path = default_test_log_path;
            if(!fs.existsSync(output_file_path)) {
                try {
                    fs.writeFileSync(output_file_path, '');
                } catch (e) {
                    console.log("Cannot write file ", e);
                }
            }

            watcher = fs.watch(output_file_path, {persistent: false}, (eventType, filename) => {
                if(filename) {
                    file_change_results = true;
                } else {
                    console.log(`filename not found`);
                }
            });
        });

        beforeEach(() => {
            file_change_results = false;
        });

        after(() => {
            zeroizeOutputFile();
            watcher.close();
            sandbox.restore();
        });

        it('Test Trace Level', (done) => {
            harper_log.setLogLevel(harper_log.TRACE);
            harper_log.trace(TRACE_LOG_MESSAGE);
            assert.equal(harper_trace_spy.calledOnce,true, "logger 'trace' function was not called.");
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling trace.");
                done();
            }, 100);
        });

        it('Test Debug Level', (done) => {
            harper_log.setLogLevel(harper_log.DEBUG);
            harper_log.debug(DEBUG_LOG_MESSAGE);
            assert.equal(harper_debug_spy.calledOnce,true, "logger 'debug' function was not called.");
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling debug.");
                done();
            }, 100);
        });

        it('Test Info Level', (done) => {
            harper_log.setLogLevel(harper_log.INFO);
            harper_log.info(INFO_LOG_MESSAGE);
            assert.equal(harper_info_spy.calledOnce,true, "logger 'info' function was not called.");
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling info.");
                done();
            }, 100);
        });

        it('Test Warn Level', (done) => {
            harper_log.setLogLevel(harper_log.WARN);
            harper_log.warn(WARN_LOG_MESSAGE);
            assert.equal(harper_warn_spy.calledOnce,true, "logger 'warn' function was not called.");
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling warn.");
                done();
            }, 100);
        });

        it('Test Error Level', (done) => {
            harper_log.setLogLevel(harper_log.ERR);
            harper_log.error(ERROR_LOG_MESSAGE);
            assert.equal(harper_error_spy.calledOnce,true, "logger 'error' function was not called.");

            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling error.");
                done();
            }, 100);
        });

        it('Test Fatal Level', (done) => {
            harper_log.setLogLevel(harper_log.FATAL);
            harper_log.fatal(FATAL_LOG_MESSAGE);
            assert.equal(harper_fatal_spy.calledOnce,true, "logger 'fatal' function was not called.");

            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling fatal.");
                done();
            }, 100);
        });

        it('Test Notify Level', (done) => {
            harper_log.setLogLevel(harper_log.NOTIFY);
            harper_log.notify(NOTIFY_LOG_MESSAGE);
            assert.equal(harper_notify_spy.calledOnce,true, "logger 'notify' function was not called.");

            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change after calling fatal.");
                done();
            }, 100);
        });
    });

    describe(`Test log level writing - WINSTON`, () => {
        before(() => {
            rewireDefaultLogger();
        });

        after(() => {
            zeroizeOutputFile();
        });

        it('Set log level to notify, should only see notify messages', (done) => {
            log_something(harper_log.NOTIFY, done);
        });

        it('Set log level to fatal, should only see fatal message', (done) => {
            log_something(harper_log.FATAL, done);
        });

        it('Set log level to error, should only see error and fatal message', (done) => {
            log_something(harper_log.ERR, done);
        });

        it('Set log level to warn, should only see error, fatal, warn message', (done) => {
            log_something(harper_log.WARN, done);
        });

        it('Set log level to info, should see error, fatal, warn, info message', (done) => {
            log_something(harper_log.INFO, done);
        });

        it('Set log level to debug, should see all but trace', (done) => {
            log_something(harper_log.DEBUG, done);
        });

        it('Set log level to trace, should see all messages', (done) => {
            log_something(harper_log.TRACE, done);
        });
    });

    describe(`Test log level writing - WINSTON w/ Daily File Rotation`, () => {
        before(() => {
            rewireDailyLogger();
            output_file_path = daily_test_log_path;
        });

        after(() => {
            zeroizeOutputFile();
        });

        it('Set log level to notify, should only see notify messages', (done) => {
            log_something(harper_log.NOTIFY, done);
        });

        it('Set log level to fatal, should only see fatal message', (done) => {
            log_something(harper_log.FATAL, done);
        });

        it('Set log level to error, should only see error and fatal message', (done) => {
            log_something(harper_log.ERR, done);
        });

        it('Set log level to warn, should only see error, fatal, warn message', (done) => {
            log_something(harper_log.WARN, done);
        });

        it('Set log level to info, should see error, fatal, warn, info message', (done) => {
            log_something(harper_log.INFO, done);
        });

        it('Set log level to debug, should see all but trace', (done) => {
            log_something(harper_log.DEBUG, done);
        });

        it('Set log level to trace, should see all messages', (done) => {
            log_something(harper_log.TRACE, done);
        });
    });


    describe(`Test log level writing - PINO`, () => {
        before(() => {
            rewireDefaultLogger(PINO);
            output_file_path = default_test_log_path;
        });

        after(() => {
            zeroizeOutputFile();
        });

        it('Set log level to notify, should only see notify messages', (done) => {
            log_something(harper_log.NOTIFY, done);
        });

        it('Set log level to fatal, should only see fatal message', (done) => {
            log_something(harper_log.FATAL, done);
        });

        it('Set log level to error, should only see error and fatal message', (done) => {
            log_something(harper_log.ERR, done);
        });

        it('Set log level to warn, should only see error, fatal, warn message', (done) => {
            log_something(harper_log.WARN, done);
        });

        it('Set log level to info, should see error, fatal, warn, info message', (done) => {
            log_something(harper_log.INFO, done);
        });

        it('Set log level to debug, should see all but trace', (done) => {
            log_something(harper_log.DEBUG, done);
        });

        it('Set log level to trace, should see all messages', (done) => {
            log_something(harper_log.TRACE, done);
        });
    });

    describe(`Test setLogType`, () => {
        before(() => {
            rewireDefaultLogger();
            harper_log.setLogType(WINSTON);
            file_change_results = false;

            watcher = fs.watch(output_file_path, {persistent: false}, (eventType, filename) => {
                if(filename) {
                    file_change_results = true;
                } else {
                    console.log(`filename not found`);
                }
            });
        });
        after(() => {
            zeroizeOutputFile();
            watcher.close();
        });
        it('Pass in empty value, expect error written in log.', (done) => {
            harper_log.setLogType('');
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change passing bad argument to setLogType.");
                done();
            }, 100);
        });
        it('Pass invalid value, expect error written in log.', (done) => {
            harper_log.setLogType(12);
            setTimeout(() => {
                assert.equal(file_change_results, true, "Did not detect a file change passing bad argument to setLogType.");
                done();
            }, 100);
        });
    });

    describe(`Test setLogLocation`, () => {
        let new_output_file = undefined;
        let default_path = undefined;

        before(() => {
            default_path = default_test_log_path;
            new_output_file = path.join(default_test_log_dir, 'new_test_log.log');
        });

        beforeEach(() => {
            rewireDefaultLogger();
        });

        afterEach(() => {
            file_change_results = false;
            watcher.close();
        });

        after(() => {
            unlinkTestLog(new_output_file);
            unlinkTestLog(default_test_log_path);
        });

        it('set log location', (done) => {
            harper_log.error('test');
            harper_log.setLogLocation(new_output_file);
            harper_log.error('new log path was set');
            // need to wait for the logger to create and write to the file.
            setTimeout(() => {
                try {
                    watcher = fs.watch(new_output_file, {persistent: false}, (eventType, filename) => {
                        if (filename) {
                            file_change_results = true;
                        } else {
                            console.log(`filename not found`);
                        }
                    });
                } catch(err) {
                    console.error(err);
                }
                harper_log.error('test in new path');
                setTimeout(() => {
                    // Had to play with the timing on this to make it constantly pass.  Might need to be slower depending on the
                    // event loop and specs of any given system the test is run on.  Not the best way to test, but works for now.
                    assert.equal(file_change_results, true, "Did not detect a file change to new log file. This might be a timing issue with the test, not the functionality.");
                    done();
                }, 200);
            }, 200);
        });

        it('set log location with bad path, expect log written to default path', (done) => {
            const bad_log_path = undefined;
            let curr_path = harper_log.__get__('log_location');
            harper_log.error('test');
            harper_log.setLogLocation(bad_log_path);
            harper_log.error('bad log path was set');

            // need to wait for the logger to create and write to the file.
            try {
                watcher = fs.watch(curr_path, {persistent: false}, (eventType, filename) => {
                    if (filename) {
                        file_change_results = true;
                    } else {
                        console.log(`filename not found`);
                    }
                });
            } catch(err) {
                console.error(err);
            }
            harper_log.error('test in new path');
            setTimeout(() => {
                // Had to play with the timing on this to make it constantly pass.  Might need to be slower depending on the
                // event loop and specs of any given system the test is run on.  Not the best way to test, but works for now.
                assert.equal(file_change_results, true, 'Expected log written to default path.');
                done();
            }, 200);
        });
    });
});

const DEFAULT_OPTIONS_LIMIT = 100;

const TEST_READ_LOG_OBJECT = {
    "operation": "read_log",
    "from": "2017-07-10",
    // Used to ensure the errors being added are always included in default query tests
    "until": moment().add(1,'d').format("YYYY-MM-DD"),
    "limit": "1000",
    "start": "0",
    "order": "desc",
    "level":"error"
};

function getMomentDate(date) {
    if (date) {
        return moment.utc(date);
    } else {
        return moment.utc(Date.now());
    }
}

describe("Test read_log ", () => {
    let winston_configure_spy;
    let winston_query_spy;
    let test_read_log_obj;

    before(() => {
        winston_configure_spy = sandbox.spy(winston, "configure");
        winston_query_spy = sandbox.spy(winston, "query");
        rewireDefaultLogger();
        harper_log.setLogType(WINSTON);
        harper_log.setLogLevel(harper_log.ERR);
        if(fs.existsSync(default_test_log_path)) {
            try {
                zeroizeOutputFile();
            } catch (e) {
                console.log("Cannot write file ", e);
            }
        }
        harper_log.error(ERROR_LOG_MESSAGE);
        harper_log.error(ERROR_LOG_MESSAGE);
    });

    beforeEach(() => {
        harper_log.setLogType(WINSTON);
        test_read_log_obj = test_utils.deepClone(TEST_READ_LOG_OBJECT);
    });

    afterEach(() => {
        sandbox.resetHistory();
    });

    after(() => {
        rewireDefaultLogger();
        unlinkTestLog(default_test_log_path);
        unlinkTestLog(daily_test_log_path);
        sandbox.restore();
    });

    it("Should call the query method if the validator does NOT return anything", test_utils.mochaAsyncWrapper(async () => {
        let queryResults;
        let errorResponse;
        try {
            queryResults = await harper_log.readLog(test_read_log_obj);
        } catch(e) {
            errorResponse = e;
        }

        expect(winston_query_spy.calledOnce).to.equal(true);
        expect(queryResults.file.length).to.equal(2);
        expect(errorResponse).to.equal(undefined);
    }));

    it("Should throw an error if the validator returns an error value", test_utils.mochaAsyncWrapper( async () => {
        let queryResults;
        let errorResponse;
        test_read_log_obj.until="BOGO Jamba Juice!";

        try {
            queryResults = await harper_log.readLog(test_read_log_obj);
        } catch(e) {
            errorResponse = e;
        }
        expect(errorResponse).to.include.property('message');
        expect(queryResults).to.equal(undefined);
    }));

    describe("setting default Winston configuration for query", () => {
        afterEach(() => {
            sandbox.resetHistory();
        });

        it("Should configure a winston with the file name `install_log.log` when log equals install_log ", () => {
            test_read_log_obj.log = "install_log";
            harper_log.readLog(test_read_log_obj);

            expect(winston_configure_spy.args[0][0].transports[0].filename).to.equal('install_log.log');
            expect(winston_configure_spy.calledOnce).to.equal(true);
        });

        it("Should configure a winston with the file name `run_log.log` when log equals run_log ", () => {
            test_read_log_obj.log = "run_log";
            harper_log.readLog(test_read_log_obj);

            expect(winston_configure_spy.args[0][0].transports[0].filename).to.equal('run_log.log');
            expect(winston_configure_spy.calledOnce).to.equal(true);
        });

        it("Should configure winston when there is no log set in the read_log_object ", () => {
            harper_log.readLog(test_read_log_obj);

            expect(default_test_log_path).to.include(winston_configure_spy.args[0][0].transports[0].filename);
            expect(winston_query_spy.calledOnce).to.equal(true);
        });

        it("Should configure winston to query for logs when Pino is set as the logger ", () => {
            harper_log.setLogType(PINO);
            harper_log.readLog(test_read_log_obj);

            expect(default_test_log_name).to.include(winston_configure_spy.args[0][0].transports[0].filename);
            expect(winston_configure_spy.calledOnce).to.equal(true);
        });
    });

    describe("bones.query() 'options' parameter ", () => {
        const default_options_fields = harper_log.__get__('DEFAULT_LOGGER_FIELDS');
        let queryResults;

        afterEach(() => {
            queryResults = undefined;
            sandbox.resetHistory();
        });

        it("Should include 'limit' and 'fields' properties by default ", test_utils.mochaAsyncWrapper( async () => {
            delete test_read_log_obj['limit'];
            try {
                queryResults = await harper_log.readLog(test_read_log_obj);
            } catch(e) {
                expect(e).to.be.null('readLog() should not have thrown an error');
            }

            expect(queryResults.file.length).to.equal(2);

            const winston_options = winston_query_spy.args[0][0];
            expect(winston_options.limit).to.equal(DEFAULT_OPTIONS_LIMIT);
            expect(winston_options.fields).to.deep.equal(default_options_fields.WIN);
        }));

        it("Should include default 'limit' and 'fields' properties for Pino ", test_utils.mochaAsyncWrapper( async () => {
            test_read_log_obj.limit = null;
            harper_log.setLogType(PINO);
            try {
                queryResults = await harper_log.readLog(test_read_log_obj);
            } catch(e) {
                expect(e).to.equal(null, 'readLog() should not have thrown an error');
            }
            expect(queryResults.file.length).to.equal(2);

            const winston_options = winston_query_spy.args[0][0];
            expect(winston_options.limit).to.equal(DEFAULT_OPTIONS_LIMIT);
            expect(winston_options.fields).to.deep.equal(default_options_fields.PIN);
        }));

        it("Should include all values from the read_log_object that is passed in ", test_utils.mochaAsyncWrapper( async () => {
            try {
                queryResults = await harper_log.readLog(test_read_log_obj);
            } catch(e) {
                expect(e).to.equal(null, 'readLog() should not have thrown an error');
            }
            const winston_options = winston_query_spy.args[0][0];

            // Removing operation from the object for assertions b/c it is not used for the query
            delete test_read_log_obj['operation'];

            Object.keys(test_read_log_obj).forEach(option => {
                if (['from', 'until'].includes(option)) {
                    expect(winston_options[option]).to.deep.equal(moment(test_read_log_obj[option]));
                } else {
                    expect(winston_options.option).to.equal(test_read_log_obj.option);
                }
            });
            expect(queryResults.file.length).to.equal(2);
        }));

        it("Should default the 'from' and 'until' properties to represent the previous 24 hours if not included in request ", test_utils.mochaAsyncWrapper( async () => {
            delete test_read_log_obj['from'];
            delete test_read_log_obj['until'];
            const current_date = getMomentDate();

            try {
                queryResults = await harper_log.readLog(test_read_log_obj);
            } catch(e) {
                expect(e).to.equal(null, 'readLog() should not have thrown an error');
            }
            expect(queryResults.file.length).to.equal(2);

            const winston_options = winston_query_spy.args[0][0];
            expect(getMomentDate(winston_options.from).date()).to.equal( moment.utc(Date.now()).subtract(1, 'day').date());
            expect(moment(winston_options.until).isSame(current_date, 'day')).to.equal(true);
        }));

        it("Should default the 'until' property to current day if not included in request ", test_utils.mochaAsyncWrapper( async () => {
            delete test_read_log_obj['until'];

            try {
                queryResults = await harper_log.readLog(test_read_log_obj);
            } catch(e) {
                expect(e).to.equal(null, 'readLog() should not have thrown an error');
            }
            expect(queryResults.file.length).to.equal(2);

            const winston_options = winston_query_spy.args[0][0];
            expect(moment(winston_options.until).isSame(getMomentDate(), 'day')).to.equal(true);
            expect(moment(winston_options.from).isSame(test_read_log_obj.from, 'day')).to.equal(true);
        }));

        it("Should NOT include a 'level' property if not included in request", test_utils.mochaAsyncWrapper( async () => {
            delete test_read_log_obj['level'];
            try {
                queryResults = await harper_log.readLog(test_read_log_obj);
            } catch(e) {
                expect(e).to.equal(null, 'readLog() should not have thrown an error');
            }

            expect(queryResults.file.length).to.equal(2);
            const winston_options = winston_query_spy.args[0][0];
            expect(winston_options.level).to.equal(undefined);
        }));

        it("Should default 'limit' property to 100 if not included in request ", test_utils.mochaAsyncWrapper( async () => {
            delete test_read_log_obj['limit'];
            try {
                queryResults = await harper_log.readLog(test_read_log_obj);
            } catch(e) {
                expect(e).to.equal(null, 'readLog() should not have thrown an error');
            }
            expect(queryResults.file.length).to.equal(2);

            const winston_options = winston_query_spy.args[0][0];
            expect(winston_options.limit).to.equal(100);
        }));

        it("Should default 'order' property to 'desc' if not included in request", test_utils.mochaAsyncWrapper( async () => {
            delete test_read_log_obj['order'];
            try {
                queryResults = await harper_log.readLog(test_read_log_obj);
            } catch(e) {
                expect(e).to.equal(null, 'readLog() should not have thrown an error');
            }
            expect(queryResults.file.length).to.equal(2);

            const winston_options = winston_query_spy.args[0][0];
            expect(winston_options.order).to.equal('desc');
        }));

        it("Should default 'start' property to 0 if not included in request ", test_utils.mochaAsyncWrapper( async () => {
            try {
                queryResults = await harper_log.readLog(test_read_log_obj);
            } catch(e) {
                expect(e).to.equal(null, 'readLog() should not have thrown an error');
            }
            expect(queryResults.file.length).to.equal(2);

            const winston_options = winston_query_spy.args[0][0];
            expect(winston_options.start).to.equal(test_read_log_obj.start);
        }));
    });

    describe("setting daily rotation Winston configuration for query", () => {
        let test_daily_file_template = '%DATE%_test_log.log';

        before(() => {
            rewireDailyLogger();
        });

        afterEach(() => {
            sandbox.resetHistory();
        });

        it("Should configure a winston with the file name `install_log.log` when log equals install_log ", () => {
            test_read_log_obj.log = "install_log";
            harper_log.readLog(test_read_log_obj);

            expect(winston_configure_spy.args[0][0].transports[0].filename).to.equal('install_log.log');
            expect(winston_configure_spy.calledOnce).to.equal(true);
        });

        it("Should configure a winston with the file name `run_log.log` when log equals run_log ", () => {
            test_read_log_obj.log = "run_log";
            harper_log.readLog(test_read_log_obj);

            expect(winston_configure_spy.args[0][0].transports[0].filename).to.equal('run_log.log');
            expect(winston_configure_spy.calledOnce).to.equal(true);
        });

        it("Should configure a winston with daily rotation when there is no log set in the read_log_object ", () => {
            harper_log.readLog(test_read_log_obj);

            expect(test_daily_file_template).to.include(winston_configure_spy.args[0][0].transports[0].filename);
            expect(winston_query_spy.calledOnce).to.equal(true);
        });
    });
});