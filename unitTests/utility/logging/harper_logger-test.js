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
chai.use(sinon_chai)
const sinon = require('sinon');
const fs = require('fs');
const moment = require('moment');
const winston = require('winston');

const rewire = require('rewire');
const harper_log = rewire('../../../utility/logging/harper_logger');


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

// TODO: Move these spies into a describe block to avoid global scope
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

describe(`Test log writing - Winston`, function() {
    let sandbox;

    before( function() {
        sandbox = sinon.createSandbox();
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
        sandbox.resetHistory();
    });
    it('Test Trace Level', function(done) {
        if(harper_trace_spy === undefined) {
            harper_trace_spy = sandbox.spy(harper_log, 'trace');
        }
        harper_log.setLogLevel(harper_log.TRACE);
        harper_log.trace(TRACE_LOG_MESSAGE);

        assert.equal(harper_trace_spy.calledOnce,true, "logger 'trace' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling trace.");
            done();
        }, 100);
    });
    it('Test Debug Level', function(done) {
        file_change_results = false;
        if( harper_debug_spy === undefined) {
            harper_debug_spy = sandbox.spy(harper_log, 'debug');
        }
        harper_log.setLogLevel(harper_log.DEBUG);
        harper_log.debug(DEBUG_LOG_MESSAGE);

        assert.equal(harper_debug_spy.calledOnce,true, "logger 'debug' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling debug.");
            done();
        }, 100);
    });
    it('Test Info Level', function(done) {
        file_change_results = false;
        if( harper_info_spy === undefined) {
            harper_info_spy = sandbox.spy(harper_log, 'info');
        }
        harper_log.setLogLevel(harper_log.INFO);
        harper_log.info(INFO_LOG_MESSAGE);

        assert.equal(harper_info_spy.calledOnce,true, "logger 'info' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling info.");
            done();
        }, 100);
    });
    it('Test Warn Level', function(done) {
        file_change_results = false;
        if( harper_warn_spy === undefined) {
            harper_warn_spy = sandbox.spy(harper_log, 'warn');
        }
        harper_log.setLogLevel(harper_log.WARN);
        harper_log.warn(WARN_LOG_MESSAGE);

        assert.equal(harper_warn_spy.calledOnce,true, "logger 'warn' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling warn.");
            done();
        }, 100);
    });
    it('Test Error Level', function(done) {
        file_change_results = false;
        if( harper_error_spy === undefined) {
            harper_error_spy = sandbox.spy(harper_log, 'error');
        }
        harper_log.setLogLevel(harper_log.ERR);
        harper_log.error(ERROR_LOG_MESSAGE);

        assert.equal(harper_error_spy.calledOnce,true, "logger 'error' function was not called.");

        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling error.");
            done();
        }, 100);
    });
    it('Test Fatal Level', function(done) {
        file_change_results = false;
        if( harper_fatal_spy === undefined) {
            harper_fatal_spy = sandbox.spy(harper_log, 'fatal');
        }
        harper_log.setLogLevel(harper_log.FATAL);
        harper_log.fatal(FATAL_LOG_MESSAGE);

        assert.equal(harper_fatal_spy.calledOnce,true, "logger 'fatal' function was not called.");

        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling fatal.");
            done();
        }, 100);
    });

    it('Test Notify Level', function(done) {
        file_change_results = false;
        if( harper_notify_spy === undefined) {
            harper_notify_spy = sandbox.spy(harper_log, 'notify');
        }
        harper_log.setLogLevel(harper_log.NOTIFY);
        harper_log.notify(NOTIFY_LOG_MESSAGE);
        assert.equal(harper_notify_spy.calledOnce,true, "logger 'notify' function was not called.");

        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling fatal.");
            done();
        }, 100);
    });
});

describe(`Test log writing - PINO`, function() {
    let sandbox;
    before( function() {
        sandbox = sinon.createSandbox();
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
        sandbox.restore();
    });
    it('Test Trace Level', function(done) {
        if(harper_trace_spy === undefined) {
            harper_trace_spy = sandbox.spy(harper_log, 'trace');
        }
        harper_log.setLogLevel(harper_log.TRACE);
        harper_log.trace(TRACE_LOG_MESSAGE);
        assert.equal(harper_trace_spy.calledOnce,true, "logger 'trace' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling trace.");
            done();
        }, 100);
    });
    it('Test Debug Level', function(done) {
        file_change_results = false;
        if( harper_debug_spy === undefined) {
            harper_debug_spy = sandbox.spy(harper_log, 'debug');
        }
        harper_log.setLogLevel(harper_log.DEBUG);
        harper_log.debug(DEBUG_LOG_MESSAGE);
        assert.equal(harper_debug_spy.calledOnce,true, "logger 'debug' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling debug.");
            done();
        }, 100);
    });
    it('Test Info Level', function(done) {
        file_change_results = false;
        if( harper_info_spy === undefined) {
            harper_info_spy = sandbox.spy(harper_log, 'info');
        }
        harper_log.setLogLevel(harper_log.INFO);
        harper_log.info(INFO_LOG_MESSAGE);
        assert.equal(harper_info_spy.calledOnce,true, "logger 'info' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling info.");
            done();
        }, 100);
    });
    it('Test Warn Level', function(done) {
        file_change_results = false;
        if( harper_warn_spy === undefined) {
            harper_warn_spy = sandbox.spy(harper_log, 'warn');
        }
        harper_log.setLogLevel(harper_log.WARN);
        harper_log.warn(WARN_LOG_MESSAGE);
        assert.equal(harper_warn_spy.calledOnce,true, "logger 'warn' function was not called.");
        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling warn.");
            done();
        }, 100);
    });
    it('Test Error Level', function(done) {
        file_change_results = false;
        if( harper_error_spy === undefined) {
            harper_error_spy = sandbox.spy(harper_log, 'error');
        }
        harper_log.setLogLevel(harper_log.ERR);
        harper_log.error(ERROR_LOG_MESSAGE);
        assert.equal(harper_error_spy.calledOnce,true, "logger 'error' function was not called.");

        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling error.");
            done();
        }, 100);
    });
    it('Test Fatal Level', function(done) {
        file_change_results = false;
        if( harper_fatal_spy === undefined) {
            harper_fatal_spy = sandbox.spy(harper_log, 'fatal');
        }
        harper_log.setLogLevel(harper_log.FATAL);
        harper_log.fatal(FATAL_LOG_MESSAGE);
        assert.equal(harper_fatal_spy.calledOnce,true, "logger 'fatal' function was not called.");

        setTimeout( function () {
            assert.equal(file_change_results, true, "Did not detect a file change after calling fatal.");
            done();
        }, 100);
    });

    it('Test Notify Level', function(done) {
        file_change_results = false;
        if( harper_notify_spy === undefined) {
            harper_notify_spy = sandbox.spy(harper_log, 'notify');
        }
        harper_log.setLogLevel(harper_log.NOTIFY);
        harper_log.notify(NOTIFY_LOG_MESSAGE);
        assert.equal(harper_notify_spy.calledOnce,true, "logger 'notify' function was not called.");

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

const DEFAULT_OPTIONS_LIMIT = 100;

const TEST_READ_LOG_OBJECT = {
    "operation": "read_log",
    "from": "2017-07-10",
    // Used to ensure the errors being added are always included in default query tests
    "until": moment(new Date()).add(1,'days'),
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
    let winston_configure_spy;
    let winston_query_spy;
    let test_read_log_obj;

    before(function() {
        harper_log.__set__('win_logger', null);
        harper_log.setLogType(WINSTON);
        harper_log.setLogLocation(output_file_name);
        harper_log.setLogLevel(harper_log.ERR);
        if(fs.existsSync(output_file_name)) {
            try {
                zeroizeOutputFile()
            } catch (e) {
                console.log("Cannot write file ", e);
            }
        }
        harper_log.error(ERROR_LOG_MESSAGE);
        harper_log.error(ERROR_LOG_MESSAGE);
        sandbox = sinon.createSandbox();
    })

    beforeEach(function() {
        harper_log.setLogType(WINSTON);
        winston_query_spy = sandbox.spy(winston, "query");
        test_read_log_obj = test_utils.deepClone(TEST_READ_LOG_OBJECT);
    });

    afterEach(function() {
        sandbox.resetHistory();
        sandbox.resetBehavior();
        sandbox.restore();
    })

    it("Should call the query method if the validator does NOT return anything", test_utils.mochaAsyncWrapper(async function() {
        let queryResults;
        try {
            queryResults = await harper_log.readLog(test_read_log_obj);
        } catch(e) {
            expect(e).to.be.null;
        }

        expect(winston_query_spy.calledOnce).to.equal(true);
        expect(queryResults.file.length).to.equal(2);
    }));

    it("Should throw an error if the validator returns an error value", test_utils.mochaAsyncWrapper( async function() {
        test_read_log_obj.until="BOGO Jamba Juice!"
        try {
            const queryResults = await harper_log.readLog(test_read_log_obj);
            expect(queryResults).to.equal(null);
        } catch(e) {
            expect(e).to.include.property('message');
        }
    }));

    describe("setting Winston configuration for query", function() {
        beforeEach(function() {
            winston_configure_spy = sandbox.spy(winston, "configure");
        })

        it("Should configure a winston with the file name `install_log.log` when log equals install_log ", function() {
            test_read_log_obj.log = "install_log";
            harper_log.readLog(test_read_log_obj);

            expect(winston_configure_spy.args[0][0].transports[0].filename).to.equal('install_log.log');
            expect(winston_configure_spy.calledOnce).to.equal(true);
        });

        it("Should configure a winston with the file name `run_log.log` when log equals run_log ", function() {
            test_read_log_obj.log = "run_log";
            harper_log.readLog(test_read_log_obj);

            expect(winston_configure_spy.args[0][0].transports[0].filename).to.equal('run_log.log')
            expect(winston_configure_spy.calledOnce).to.equal(true);
        });

        it("Should configure winston when there is no log set in the read_log_object ", function() {
            harper_log.readLog(test_read_log_obj);

            expect(global.log_location).to.include(winston_configure_spy.args[0][0].transports[0].filename);
            expect(winston_query_spy.calledOnce).to.equal(true);
        });

        it("Should configure winston to query for logs when Pino is set as the logger ", function() {
            harper_log.setLogType(PINO);
            harper_log.readLog(test_read_log_obj);

            expect(global.log_location).to.include(winston_configure_spy.args[0][0].transports[0].filename);
            expect(winston_configure_spy.calledOnce).to.equal(true);
        })
    });

    describe("bones.query() 'options' parameter ", function() {
        const default_options_fields = harper_log.__get__('DEFAULT_LOGGER_FIELDS')
        let queryResults;

        afterEach(function() {
            queryResults = undefined;
        })

        it("Should include 'limit' and 'fields' properties by default ", test_utils.mochaAsyncWrapper( async function() {
            delete test_read_log_obj['limit'];
            try {
                queryResults = await harper_log.readLog(test_read_log_obj);
            } catch(e) {
                expect(e).to.be.null('readLog() should not have thrown an error');
            }

            expect(queryResults.file.length).to.equal(2);

            const winston_options = winston_query_spy.args[0][0];
            expect(winston_options.limit).to.equal(DEFAULT_OPTIONS_LIMIT);
            expect(winston_options.fields).to.equal(default_options_fields.WIN);
        }));

        it("Should include default 'limit' and 'fields' properties for Pino ", test_utils.mochaAsyncWrapper( async function() {
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
            expect(winston_options.fields).to.equal(default_options_fields.PIN);
        }));

        it("Should include all values from the read_log_object that is passed in ", test_utils.mochaAsyncWrapper( async function() {
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
            })
            expect(queryResults.file.length).to.equal(2);
        }));

        it("Should default the 'from' and 'until' properties to represent the previous 24 hours if not included in request ", test_utils.mochaAsyncWrapper( async function() {
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
            expect(getMomentDate(winston_options.from).date()).to.equal(current_date.date()-1);
            expect(moment(winston_options.until).isSame(current_date, 'day')).to.equal(true);
        }));

        it("Should default the 'until' property to current day if not included in request ", test_utils.mochaAsyncWrapper( async function() {
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

        it("Should NOT include a 'level' property if not included in request", test_utils.mochaAsyncWrapper( async function() {
            delete test_read_log_obj['level'];
            try {
                queryResults = await harper_log.readLog(test_read_log_obj);
            } catch(e) {
                expect(e).to.equal(null, 'readLog() should not have thrown an error');
            }
            // There will be three log objects sent back for this query because of the trace log set when Winston is instantiated
            expect(queryResults.file.length).to.equal(3);

            const winston_options = winston_query_spy.args[0][0];
            expect(winston_options.level).to.equal(undefined);
        }));

        it("Should default 'limit' property to 100 if not included in request ", test_utils.mochaAsyncWrapper( async function() {
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

        it("Should default 'order' property to 'desc' if not included in request", test_utils.mochaAsyncWrapper( async function() {
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

        it("Should default 'start' property to 0 if not included in request ", test_utils.mochaAsyncWrapper( async function() {
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
});