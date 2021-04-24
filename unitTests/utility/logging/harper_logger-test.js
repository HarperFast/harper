'use strict';

//const test_utils = require('../../test_utils');
const sinon = require('sinon');
const chai = require('chai');
const path = require('path');
const pino = require('pino');
const moment = require('moment');
const mock_require = require('mock-require');
const fs_extra = require('fs-extra');
const fs = require('fs');
const sinon_chai = require('sinon-chai');
const expect = chai.expect;
chai.use(sinon_chai);
const rewire = require('rewire');
let harper_logger_rw;

const LOG_DIR_TEST = 'testLogger';
const LOG_NAME_TEST = 'log_unit_test.log';
const TEST_LOG_DIR = path.join(__dirname, LOG_DIR_TEST);
const LOG_PATH_TEST = path.join(TEST_LOG_DIR, LOG_NAME_TEST);
const HDB_ROOT_TEST = __dirname;
const LOG_LEVEL = {
    NOTIFY: 'notify',
    FATAL: 'fatal',
    ERROR: 'error',
    WARN: 'warn',
    INFO: 'info',
    DEBUG: 'debug',
    TRACE: 'trace'
};

const LOG_MSGS_TEST = {
    NOTIFY: 'notify log',
    FATAL: 'fatal log',
    ERROR: 'error log',
    WARN: 'warn log',
    INFO: 'info log',
    DEBUG: 'debug log',
    TRACE: 'trace log'
};

function setMockPropParams(daily_rotate, daily_max, log_level, log_path, hdb_root) {
    const props_reader_mock = () => ({
        append: () => {},
        get: (value) => {
            switch (value) {
                case 'LOG_DAILY_ROTATE':
                    return daily_rotate;
                case 'LOG_MAX_DAILY_FILES':
                    return daily_max;
                case 'LOG_LEVEL':
                    return log_level;
                case 'LOG_PATH':
                    return log_path;
                case 'HDB_ROOT':
                    return hdb_root;
                default:
                    break;
            }
        }
    });

    mock_require('properties-reader', props_reader_mock);
}

function logAllTheLevels() {
    harper_logger_rw.trace(LOG_MSGS_TEST.TRACE);
    harper_logger_rw.debug(LOG_MSGS_TEST.DEBUG);
    harper_logger_rw.info(LOG_MSGS_TEST.INFO);
    harper_logger_rw.warn(LOG_MSGS_TEST.WARN);
    harper_logger_rw.error(LOG_MSGS_TEST.ERROR);
    harper_logger_rw.fatal(LOG_MSGS_TEST.FATAL);
    harper_logger_rw.notify(LOG_MSGS_TEST.NOTIFY);
}

function testAllTheLevelsLogged(log) {
    expect(log.includes(LOG_MSGS_TEST.TRACE)).to.be.equal(true, "Log does not contain trace message");
    expect(log.includes(LOG_MSGS_TEST.DEBUG)).to.be.equal(true, "Log does not contain debug message");
    expect(log.includes(LOG_MSGS_TEST.INFO)).to.be.equal(true, "Log does not contain info message");
    expect(log.includes(LOG_MSGS_TEST.WARN)).to.be.equal(true, "Log does not contain warn message");
    expect(log.includes(LOG_MSGS_TEST.ERROR)).to.be.equal(true, "Log does not contain error message");
    expect(log.includes(LOG_MSGS_TEST.FATAL)).to.be.equal(true, "Log does not contain fatal message");
    expect(log.includes(LOG_MSGS_TEST.NOTIFY)).to.be.equal(true, "Log does not contain notify message");
}

function testWriteLogBulkWrite() {
    harper_logger_rw.writeLog(LOG_LEVEL.TRACE, LOG_MSGS_TEST.TRACE);
    harper_logger_rw.writeLog(LOG_LEVEL.DEBUG, LOG_MSGS_TEST.DEBUG);
    harper_logger_rw.writeLog(LOG_LEVEL.INFO, LOG_MSGS_TEST.INFO);
    harper_logger_rw.writeLog(LOG_LEVEL.WARN, LOG_MSGS_TEST.WARN);
    harper_logger_rw.writeLog(LOG_LEVEL.ERROR, LOG_MSGS_TEST.ERROR);
    harper_logger_rw.writeLog(LOG_LEVEL.FATAL, LOG_MSGS_TEST.FATAL);
    harper_logger_rw.writeLog(LOG_LEVEL.NOTIFY, LOG_MSGS_TEST.NOTIFY);
}

function convertLogToJson(log_path) {
    const log = fs_extra.readFileSync(log_path).toString().replace(/\n/g, ",");
    let log_json = `[${log.slice(0, -1)}]`;
    return JSON.parse(log_json);
}

function testWriteLogBulkTests(log_path) {
    const log_json = convertLogToJson(log_path);

    let trace_found, debug_found, info_found, warn_found, error_found, fatal_found, notify_found;
    for (const log of log_json) {
        if (log.level === LOG_LEVEL.TRACE && log.hasOwnProperty('timestamp') && log.message === LOG_MSGS_TEST.TRACE) {
            trace_found = true;
        }

        if (log.level === LOG_LEVEL.DEBUG && log.hasOwnProperty('timestamp') && log.message === LOG_MSGS_TEST.DEBUG) {
            debug_found = true;
        }

        if (log.level === LOG_LEVEL.INFO && log.hasOwnProperty('timestamp') && log.message === LOG_MSGS_TEST.INFO) {
            info_found = true;
        }

        if (log.level === LOG_LEVEL.WARN && log.hasOwnProperty('timestamp') && log.message === LOG_MSGS_TEST.WARN) {
            warn_found = true;
        }

        if (log.level === LOG_LEVEL.ERROR && log.hasOwnProperty('timestamp') && log.message === LOG_MSGS_TEST.ERROR) {
            error_found = true;
        }

        if (log.level === LOG_LEVEL.FATAL && log.hasOwnProperty('timestamp') && log.message === LOG_MSGS_TEST.FATAL) {
            fatal_found = true;
        }

        if (log.level === LOG_LEVEL.NOTIFY && log.hasOwnProperty('timestamp') && log.message === LOG_MSGS_TEST.NOTIFY) {
            notify_found = true;
        }
    }

    expect(trace_found).to.be.equal(true, "Log does not contain trace message");
    expect(debug_found).to.be.equal(true, "Log does not contain debug message");
    expect(info_found).to.be.equal(true, "Log does not contain info message");
    expect(warn_found).to.be.equal(true, "Log does not contain warn message");
    expect(error_found).to.be.equal(true, "Log does not contain error message");
    expect(fatal_found).to.be.equal(true, "Log does not contain fatal message");
    expect(notify_found).to.be.equal(true, "Log does not contain notify message");
}

describe('Test harper_logger module', () => {
    const sandbox = sinon.createSandbox();
    let pino_spy = sandbox.spy(pino);

    before(() => {

    });

    after(() => {
        mock_require.stopAll();
        sandbox.restore();
    });

    describe('Test createLog function', () => {
        after(() => {
            fs_extra.emptyDirSync(TEST_LOG_DIR);
        });

        it('Test log is create with file name provided and contains logs', (done) => {
            setMockPropParams(false, 2, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            const file_exists = fs_extra.pathExistsSync(LOG_PATH_TEST);
            expect(file_exists).to.be.true;
            logAllTheLevels();

            // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
            setTimeout(() => {
                const log = fs_extra.readFileSync(LOG_PATH_TEST).toString();
                testAllTheLevelsLogged(log);

                done();
            }, 5000);
        }).timeout(8000);

        it('Test log is create with default name and contains logs', (done) => {
            setMockPropParams(false, 2, LOG_LEVEL.TRACE, TEST_LOG_DIR, HDB_ROOT_TEST);
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            const file_exists = fs_extra.pathExistsSync(path.join(TEST_LOG_DIR, 'hdb_log.log'));
            expect(file_exists).to.be.true;
            logAllTheLevels();

            // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
            setTimeout(() => {
                const log = fs_extra.readFileSync(LOG_PATH_TEST).toString();
                testAllTheLevelsLogged(log);

                done();
            }, 5000);
        }).timeout(8000);

        it('Test log is created when log location not defined', () => {
            const temp_log_dir = path.join(__dirname, 'log');
            fs_extra.mkdirpSync(temp_log_dir);
            setMockPropParams(false, 2, LOG_LEVEL.TRACE, undefined, HDB_ROOT_TEST);
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            const file_exists = fs_extra.pathExistsSync(temp_log_dir);
            expect(file_exists).to.be.true;
            fs_extra.removeSync(temp_log_dir);
        });

        it('Test log is created if log path provided but dir does not exist', () => {
            const temp_log_dir = path.join(__dirname, 'log');
            const temp_log_path = path.join(temp_log_dir, 'my_log.log');
            setMockPropParams(false, 2, LOG_LEVEL.TRACE, temp_log_path, HDB_ROOT_TEST);
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            const file_exists = fs_extra.pathExistsSync(temp_log_path);
            expect(file_exists).to.be.true;
            fs_extra.removeSync(temp_log_dir);
        });

        it('Test log is create when just dir is provided and it does not exist', () => {
            const temp_log_dir = path.join(__dirname, 'log');
            const expected_log_path = path.join(temp_log_dir, 'hdb_log.log');
            setMockPropParams(false, 2, LOG_LEVEL.TRACE, temp_log_dir, HDB_ROOT_TEST);
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            const file_exists = fs_extra.pathExistsSync(expected_log_path);
            expect(file_exists).to.be.true;
            fs_extra.removeSync(temp_log_dir);
        });

        it('Test log includes date in name if daily rotate set', (done) => {
            setMockPropParams(true, 2, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            const expected_log_path = path.join(TEST_LOG_DIR, `${moment().utc().format('YYYY-MM-DD')}_${LOG_NAME_TEST}`);
            const file_exists = fs_extra.pathExistsSync(expected_log_path);
            expect(file_exists).to.be.true;
            logAllTheLevels();

            // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
            setTimeout(() => {
                const log = fs_extra.readFileSync(LOG_PATH_TEST).toString();
                testAllTheLevelsLogged(log);

                done();
            }, 5000);
        }).timeout(8000);

        it('Test error from create log with log file provided handled correctly', (done) => {
            const temp_default_log_dir = path.join(__dirname, 'log');
            fs_extra.mkdirpSync(temp_default_log_dir);
            const temp_log_dir = path.join(__dirname, 'log_here', 'my_log.log');
            const expected_log_path = path.join(temp_default_log_dir, 'hdb_log.log');
            setMockPropParams(false, 2, LOG_LEVEL.TRACE, temp_log_dir, HDB_ROOT_TEST);
            const fs_mkdir_stub = sandbox.stub(fs, 'mkdirSync').throws(new Error('There has been an error'));
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            const file_exists = fs_extra.pathExistsSync(expected_log_path);
            expect(file_exists).to.be.true;

            // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
            setTimeout(() => {
                const log = fs_extra.readFileSync(expected_log_path).toString();
                expect(log.includes("message\":\"Attempted to create log directory from settings file but failed.  Using default log path - 'hdb/log/hdb_log.log'")).to.be.true;
                fs_extra.removeSync(temp_default_log_dir);
                fs_mkdir_stub.restore();
                done();
            }, 5000);
        }).timeout(8000);

        it('Test error from create log with no log file provided handled correctly', (done) => {
            const temp_default_log_dir = path.join(__dirname, 'log');
            fs_extra.mkdirpSync(temp_default_log_dir);
            const temp_log_dir = path.join(__dirname, 'log_here');
            const expected_log_path = path.join(temp_default_log_dir, 'hdb_log.log');
            setMockPropParams(false, 2, LOG_LEVEL.TRACE, temp_log_dir, HDB_ROOT_TEST);
            const fs_mkdir_stub = sandbox.stub(fs, 'mkdirSync').throws(new Error('There has been an error'));
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            const file_exists = fs_extra.pathExistsSync(expected_log_path);
            expect(file_exists).to.be.true;

            // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
            setTimeout(() => {
                const log = fs_extra.readFileSync(expected_log_path).toString();
                expect(log.includes("message\":\"Attempted to create log directory from settings file but failed.  Using default log path - 'hdb/log/hdb_log.log'")).to.be.true;
                fs_extra.removeSync(temp_default_log_dir);
                fs_mkdir_stub.restore();
                done();
            }, 5000);
        }).timeout(8000);

        it('Test error from create log handled correctly', (done) => {
            const temp_default_log_dir = path.join(__dirname, 'log');
            fs_extra.mkdirpSync(temp_default_log_dir);
            const expected_log_path = path.join(temp_default_log_dir, 'hdb_log.log');
            setMockPropParams(false, 2, LOG_LEVEL.TRACE, 123, HDB_ROOT_TEST);
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            const file_exists = fs_extra.pathExistsSync(expected_log_path);
            expect(file_exists).to.be.true;

            // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
            setTimeout(() => {
                const log = fs_extra.readFileSync(expected_log_path).toString();
                expect(log.includes("message\":\"Attempted to create log directory from settings file but failed.  Using default log path - 'hdb/log/hdb_log.log'")).to.be.true;
                fs_extra.removeSync(temp_default_log_dir);
                done();
            }, 5000);
        }).timeout(8000);
    });
    
    describe('Test writeLog function', () => {

/*        it('Test writeLog writes to log as expected happy path', (done) => {
            setMockPropParams(false, 2, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            const file_exists = fs_extra.pathExistsSync(LOG_PATH_TEST);
            expect(file_exists).to.be.true;
            testWriteLogBulkWrite(LOG_PATH_TEST);

            //The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
            setTimeout(() => {
                testWriteLogBulkTests();
                done();
            }, 5000);
        }).timeout(8000);

        // This test relies on the one above to create logger.
        it('Test writeLog sets level to error if param not passed', (done) => {
            harper_logger_rw.writeLog(undefined, 'Undefined level log');

            // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
            setTimeout(() => {
                const log_json = convertLogToJson(LOG_PATH_TEST);
                let log_found = false;
                for (const log of log_json) {
                    if (log.level === LOG_LEVEL.ERROR && log.hasOwnProperty('timestamp') && log.message === 'Undefined level log') {
                        log_found = true;
                    }
                }
                expect(log_found).to.be.true;
                fs_extra.removeSync(LOG_PATH_TEST);
                done();
            }, 5000);
        }).timeout(8000);*/

        it('Test writeLog with daily rotate', (done) => {
            setMockPropParams(true, 3, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            const expected_log_path = path.join(TEST_LOG_DIR, `${moment().utc().format('YYYY-MM-DD')}_${LOG_NAME_TEST}`);
            const file_exists = fs_extra.pathExistsSync(expected_log_path);
            expect(file_exists).to.be.true;
            testWriteLogBulkWrite();

            //The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
            setTimeout(() => {
                testWriteLogBulkTests(expected_log_path);
                done();
            }, 5000);
        }).timeout(8000);

        // This test relies on the one above to create logger.
        it('Test writeLog with daily rotate next day log created', (done) => {
            const tomorrows_date = moment().utc().add(1, 'days');
            sandbox.useFakeTimers({now: new Date(tomorrows_date.format('YYYY,MM,DD'))});
            harper_logger_rw.writeLog('fatal', 'Test a new date log is created');
            const expected_log_path = path.join(TEST_LOG_DIR, `${tomorrows_date.format('YYYY-MM-DD')}_${LOG_NAME_TEST}`);
            const file_exists = fs_extra.pathExistsSync(expected_log_path);
            expect(file_exists).to.be.true;
            testWriteLogBulkWrite();

            //The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
            setTimeout(() => {
                testWriteLogBulkTests(expected_log_path);
                done();
            }, 5000);
        }).timeout(8000);
    });
});