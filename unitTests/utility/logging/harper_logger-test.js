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
const sinon = require('sinon');
const fs = require('fs');
const moment = require('moment');
const winston = require('winston');

const rewire = require('rewire');
const harper_log = rewire('../../../utility/logging/harper_logger');
const validator = require('../../../validation/validationWrapper');


let output_file_name = global.log_location;
let file_change_results = false;

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
    if(ZEROIZE_OUTPUT_FILE) {
        fs.truncateSync(output_file_name, 0);
    }
}

function log_something(level, done) {
    harper_log.setLogLevel(level);
    harper_log.notify(LOG_DELIMITER+level);
    printLogs();
    harper_log.notify(LOG_DELIMITER+level);
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

    it('Test Notify Level', function(done) {
        file_change_results = false;
        if( harper_notify_spy === undefined) {
            harper_notify_spy = sinon.spy(harper_log, 'notify');
        }
        harper_log.setLogLevel(harper_log.NOTIFY);
        harper_log.notify(NOTIFY_LOG_MESSAGE);
        assert.equal(harper_notify_spy.called,true, "logger 'notify' function was not called.");

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

    it('Test Notify Level', function(done) {
        file_change_results = false;
        if( harper_notify_spy === undefined) {
            harper_notify_spy = sinon.spy(harper_log, 'notify');
        }
        harper_log.setLogLevel(harper_log.NOTIFY);
        harper_log.notify(NOTIFY_LOG_MESSAGE);
        assert.equal(harper_notify_spy.called,true, "logger 'notify' function was not called.");

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
    it('Set log level to notify, should only see notify messages', function (done) {
        log_something(harper_log.NOTIFY, done);
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
    it('Set log level to notify, should only see notify messages', function (done) {
        log_something(harper_log.NOTIFY, done);
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

describe(`Test setLogLocation`, function (done) {
    let new_output_file = undefined;
    before(function () {
        harper_log.setLogType(WINSTON);
        file_change_results = false;

    });

    afterEach(function () {
        try {
            zeroizeOutputFile();
            fs.unlinkSync(new_output_file);
            fs.unlinkSync(output_file_name);
        } catch(err) {
            // no-op
        }
    });
    it('set log location', function (done) {
        new_output_file = '../unitTests/testlog.log';
        harper_log.__set__('log_location', '../run_log.log');
        harper_log.error('test');
        harper_log.setLogLocation(new_output_file);
        harper_log.error('new log path was set');
        // need to wait for the logger to create and write to the file.
        setTimeout( function () {
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
            setTimeout( function () {
                // Had to play with the timing on this to make it constantly pass.  Might need to be slower depending on the
                // event loop and specs of any given system the test is run on.  Not the best way to test, but works for now.
                assert.equal(file_change_results, true, "Did not detect a file change to new log file. This might be a timing issue with the test, not the functionality.");
                done();
            }, 1300);
        }, 500);
    });
    it('set log location with bad path, expect log written to default path', function (done) {
        new_output_file = undefined;
        let default_path = '../run_log.log';
        harper_log.__set__('log_location', default_path);
        harper_log.error('test');
        harper_log.setLogLocation(new_output_file);
        harper_log.error('bad log path was set');
        // need to wait for the logger to create and write to the file.
        try {
                watcher = fs.watch(default_path, {persistent: false}, (eventType, filename) => {
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
            setTimeout( function () {
                // Had to play with the timing on this to make it constantly pass.  Might need to be slower depending on the
                // event loop and specs of any given system the test is run on.  Not the best way to test, but works for now.
                assert.equal(file_change_results, true, 'Expected log written to default path.');
                done();
            }, 1200);
    });
});


const DEFAULT_OPTIONS = {
    limit: 100,
    win_fields: ['level','message','timestamp'],
    pin_fields: ['level','msg','time']
}

const TEST_READ_LOG_OBJECT = {
    "operation": "read_log",
    "from": "2017-07-10",
    "until": "2019-07-11",
    "limit": "1000",
    "start": "0",
    "order": "desc",
    "level":"error"
}

function getMomentDate(date) {
    if (date) {
        return moment.utc(date);
    } else {
        return moment.utc(Date.now());
    }
}

describe("Test read_log ", function() {
    let sandbox;
    let winstonConfigSpy;
    let callbackSpy;
    let winstonQuerySpy;
    let testReadLogObj;

    before(function() {
        harper_log.__set__('win_logger', undefined);
        harper_log.__set__('pin_logger', undefined);
        harper_log.__set__('log_location', 'hdb_log.log')
        harper_log.setLogType(WINSTON)
        harper_log.setLogLevel(harper_log.WARN)

        sandbox = sinon.createSandbox();
    })

    beforeEach(function() {
        callbackSpy = sandbox.spy();
        winstonQuerySpy = sandbox.spy(winston, "query");
        testReadLogObj = test_utils.deepClone(TEST_READ_LOG_OBJECT);
    });

    afterEach(function() {
        harper_log.setLogType(WINSTON);
        sandbox.resetHistory();
        sandbox.resetBehavior();
        sandbox.restore();
    })

    it("Should call the query method if the validator does NOT return anything", function() {
        sandbox.stub(validator, "validateObject").returns(null);
        harper_log.read_log(testReadLogObj, callbackSpy);

        assert.strictEqual(winstonQuerySpy.calledOnce, true);
    });

    it("Should call the callback method with the data returned from the validator if returned", function() {
        const TEST_VALIDATOR_DATA = "Validator return data"
        sandbox.stub(validator, "validateObject").returns(TEST_VALIDATOR_DATA);
        harper_log.read_log(testReadLogObj, callbackSpy);

        assert.strictEqual(callbackSpy.args[0][0], TEST_VALIDATOR_DATA);
    });

    describe("setting Winston configuration", function() {
        beforeEach(function() {
            winstonConfigSpy = sandbox.spy(winston, "configure");
        })

        it("Should configure a winston with the file name `install_log.log` when log equals install_log ", function() {
            testReadLogObj.log = "install_log";
            harper_log.read_log(testReadLogObj, callbackSpy);

            assert.strictEqual(winstonConfigSpy.args[0][0].transports[0].filename, 'install_log.log')
            assert.strictEqual(winstonConfigSpy.calledOnce, true);
        });

        it("Should configure a winston with the file name `run_log.log` when log equals run_log ", function() {
            testReadLogObj.log = "run_log";
            harper_log.read_log(testReadLogObj, callbackSpy);

            assert.strictEqual(winstonConfigSpy.args[0][0].transports[0].filename, 'run_log.log')
            assert.strictEqual(winstonConfigSpy.calledOnce, true);
        });

        it("Should configure winston when there is no log set in the read_log_object ", function() {
            harper_log.read_log(testReadLogObj, callbackSpy);

            assert.strictEqual(winstonQuerySpy.calledOnce, true);
        });

        it("Should configure winston to query for logs when Pino is set as the logger ", function() {
            harper_log.setLogType(PINO);
            harper_log.read_log(testReadLogObj, callbackSpy);

            assert.strictEqual(winstonConfigSpy.args[0][0].transports[0].filename, 'hdb_log.log')
            assert.strictEqual(winstonConfigSpy.calledOnce, true);
        })
    });

    describe("bones.query() 'options' parameter ", function() {

        it("Should include 'limit' and 'fields' properties by default ", function() {
            testReadLogObj.limit = null;
            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.deepStrictEqual(winstonOptions.fields, DEFAULT_OPTIONS.win_fields);
            assert.strictEqual(winstonOptions.limit, DEFAULT_OPTIONS.limit);
        });

        it("Should include 'fields' properties for Pino if Pino logging is turned on ", function() {
            harper_log.setLogType(PINO);
            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.deepStrictEqual(winstonOptions.fields, DEFAULT_OPTIONS.pin_fields);
        });

        it("Should include a 'from' property with formatted date value ", function() {
            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.strictEqual(winstonOptions.from.isValid(), true);
            assert.deepStrictEqual(winstonOptions.from, moment(testReadLogObj.from));
        });

        it("Should include a 'until' property with formatted date value ", function() {
            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.strictEqual(winstonOptions.until.isValid(), true);
            assert.deepStrictEqual(winstonOptions.until, moment(testReadLogObj.until));
        });

        it("Should default the 'from' and 'until' properties to represent the previous 24 hours if not included in request ", function() {
            delete testReadLogObj['from'];
            delete testReadLogObj['until'];
            const current_date = getMomentDate();

            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.strictEqual(getMomentDate(winstonOptions.from).date(), current_date.date()-1);
            assert.strictEqual(moment(winstonOptions.until).isSame(current_date, 'day'), true);
        });

        it("Should default the 'until' property to current day if not included in request ", function() {
            delete testReadLogObj['until'];

            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.strictEqual(moment(winstonOptions.until).isSame(getMomentDate(), 'day'), true);
            assert.strictEqual(moment(winstonOptions.from).isSame(testReadLogObj.from, 'day'), true);
        });

        it("Should include a 'level' property ", function() {
            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.strictEqual(winstonOptions.level, testReadLogObj.level);
        });

        it("Should NOT include a 'level' property if not included in request", function() {
            delete testReadLogObj['level'];

            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.strictEqual(winstonOptions.level, undefined);
        });

        it("Should include a 'limit' property ", function() {
            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.strictEqual(winstonOptions.limit, testReadLogObj.limit);
        });

        it("Should default 'limit' property to 100 if not included in request ", function() {
            delete testReadLogObj['limit'];

            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.strictEqual(winstonOptions.limit, 100);
        });

        it("Should include a 'order' property ", function() {
            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.strictEqual(winstonOptions.order, testReadLogObj.order);
        });

        it("Should default 'order' property to 'desc' if not included in request", function() {
            delete testReadLogObj['order'];

            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.strictEqual(winstonOptions.order, 'desc');
        });

        it("Should include a 'start' property ", function() {
            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.strictEqual(winstonOptions.start, testReadLogObj.start);
        });

        it("Should default 'start' property to 0 if not included in request ", function() {
            harper_log.read_log(testReadLogObj, callbackSpy);
            const winstonOptions = winstonQuerySpy.args[0][0];

            assert.strictEqual(winstonOptions.start, testReadLogObj.start);
        });
    });

    describe("queryCallback() for bones.query", function() {
        const queryCallback = harper_log.__get__('queryCallback');
        const queryResults = { results: [1, 2, 3] };
        const queryError = { error: "There was an error" };

        it("Should call the callback with the results if an error value is not passed in ", function() {
            queryCallback(null, queryResults, callbackSpy);

            assert.strictEqual(callbackSpy.calledOnce, true);
            assert.strictEqual(callbackSpy.calledWith(null, queryResults), true);
        });

        it("Should call the callback with the error if an error value is passed in ", function() {
            queryCallback(queryError, queryResults, callbackSpy);

            assert.strictEqual(callbackSpy.calledOnce, true);
            assert.strictEqual(callbackSpy.calledWith(queryError), true);
        });
    });
});