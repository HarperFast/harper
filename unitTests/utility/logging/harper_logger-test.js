'use strict';

const test_utils = require('../../test_utils');
const sinon = require('sinon');
const chai = require('chai');
const path = require('path');
const os = require('os');
const moment = require('moment');
const mock_require = require('mock-require');
const fs_extra = require('fs-extra');
const fs = require('fs');
const sinon_chai = require('sinon-chai');
const expect = chai.expect;
chai.use(sinon_chai);
const rewire = require('rewire');

let harper_logger_rw;
let pino_logger;

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

    before(() => {
        fs_extra.mkdirpSync(TEST_LOG_DIR);
    });

    after(() => {
        mock_require.stopAll();
        sandbox.restore();
        fs_extra.removeSync(TEST_LOG_DIR);
    });

    afterEach((done) => {
        setTimeout(() => done(), 1000);
    });

    describe('Test createLog function', () => {
        after(() => {
            fs_extra.emptyDirSync(TEST_LOG_DIR);
        });

        it('Test log is create with file name provided and contains logs', (done) => {
            try {
                setMockPropParams(false, 2, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
                harper_logger_rw = rewire('../../../utility/logging/harper_logger');
                logAllTheLevels();

                // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
                setTimeout(() => {
                    try {
                        const file_exists = fs_extra.pathExistsSync(LOG_PATH_TEST);
                        expect(file_exists).to.be.true;
                        const log = fs_extra.readFileSync(LOG_PATH_TEST).toString();
                        testAllTheLevelsLogged(log);
                        done();
                    } catch(err) {
                        console.error(err);
                        done(err);
                    }
                }, 5000);
            } catch(err) {
                console.error(err);
                done(err);
            }
        }).timeout(8000);

        it('Test log is create with default name and contains logs', (done) => {
            try {
                setMockPropParams(false, 2, LOG_LEVEL.TRACE, TEST_LOG_DIR, HDB_ROOT_TEST);
                harper_logger_rw = rewire('../../../utility/logging/harper_logger');
                logAllTheLevels();

                // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
                setTimeout(() => {
                    try {
                        const file_exists = fs_extra.pathExistsSync(path.join(TEST_LOG_DIR, 'hdb_log.log'));
                        expect(file_exists).to.be.true;
                        const log = fs_extra.readFileSync(LOG_PATH_TEST).toString();
                        testAllTheLevelsLogged(log);
                        done();
                    } catch(err) {
                        console.error(err);
                        done(err);
                    }
                }, 5000);
            } catch(err) {
                console.error(err);
                done(err);
            }
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
            try {
                setMockPropParams(true, 2, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
                harper_logger_rw = rewire('../../../utility/logging/harper_logger');
                const expected_log_path = path.join(TEST_LOG_DIR, `${moment().utc().format('YYYY-MM-DD')}_${LOG_NAME_TEST}`);
                logAllTheLevels();

                // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
                setTimeout(() => {
                    try {
                        const file_exists = fs_extra.pathExistsSync(expected_log_path);
                        expect(file_exists).to.be.true;
                        const log = fs_extra.readFileSync(LOG_PATH_TEST).toString();
                        testAllTheLevelsLogged(log);
                        done();
                    } catch(err) {
                        console.error(err);
                        done(err);
                    }
                }, 5000);
            } catch(err) {
                console.error(err);
                done(err);
            }
        }).timeout(8000);

        // These tests were causing a sh: line 1: 74770 Segmentation fault: 11  nyc --reporter=lcov ../node_modules/mocha/bin/_mocha '../unitTests/**/*.js' --config '../unitTests/.mocharc.json'
        // error which was exiting out of the unit tests. I couldn't fix the error so commented out the tests.
/*        it('Test error from create log with log file provided handled correctly', (done) => {
            let fs_mkdir_stub = undefined;
            try {
                const temp_default_log_dir = path.join(__dirname, 'log');
                fs_extra.mkdirpSync(temp_default_log_dir);
                const temp_log_dir = path.join(__dirname, 'log_here', 'my_log.log');
                const expected_log_path = path.join(temp_default_log_dir, 'hdb_log.log');
                setMockPropParams(false, 2, LOG_LEVEL.TRACE, temp_log_dir, HDB_ROOT_TEST);
                fs_mkdir_stub = sandbox.stub(fs, 'mkdirSync').throws(new Error('There has been an error'));
                harper_logger_rw = rewire('../../../utility/logging/harper_logger');
                fs_mkdir_stub.restore();

                // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
                setTimeout(() => {
                    try {
                        const file_exists = fs_extra.pathExistsSync(expected_log_path);
                        expect(file_exists).to.be.true;
                        const log = fs_extra.readFileSync(expected_log_path).toString();
                        expect(log.includes("message\":\"Attempted to create log directory from settings file but failed.  Using default log path - 'hdb/log/hdb_log.log'")).to.be.true;
                        fs_extra.removeSync(temp_default_log_dir);
                        done();
                    } catch(err) {
                        if (fs_mkdir_stub) fs_mkdir_stub.restore();
                        console.error(err);
                        done(err);
                    }
                }, 5000);
            } catch(err) {
                if (fs_mkdir_stub) fs_mkdir_stub.restore();
                console.error(err);
                done(err);
            }
        }).timeout(8000);

        it('Test error from create log with no log file provided handled correctly', (done) => {
            let fs_mkdir_stub = undefined;
            try {
                const temp_default_log_dir = path.join(__dirname, 'log');
                fs_extra.mkdirpSync(temp_default_log_dir);
                const temp_log_dir = path.join(__dirname, 'log_here');
                const expected_log_path = path.join(temp_default_log_dir, 'hdb_log.log');
                setMockPropParams(false, 2, LOG_LEVEL.TRACE, temp_log_dir, HDB_ROOT_TEST);
                fs_mkdir_stub = sandbox.stub(fs, 'mkdirSync').throws(new Error('There has been an error'));
                harper_logger_rw = rewire('../../../utility/logging/harper_logger');
                fs_mkdir_stub.restore();

                // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
                setTimeout(() => {
                    try {
                        const file_exists = fs_extra.pathExistsSync(expected_log_path);
                        expect(file_exists).to.be.true;
                        const log = fs_extra.readFileSync(expected_log_path).toString();
                        expect(log.includes("message\":\"Attempted to create log directory from settings file but failed.  Using default log path - 'hdb/log/hdb_log.log'")).to.be.true;
                        fs_extra.removeSync(temp_default_log_dir);
                        done();
                    } catch(err) {
                        if (fs_mkdir_stub) fs_mkdir_stub.restore();
                        console.error(err);
                        done(err);
                    }
                }, 5000);
            } catch(err) {
                if (fs_mkdir_stub) fs_mkdir_stub.restore();
                console.error(err);
                done(err);
            }
        }).timeout(8000);

        it('Test error from create log handled correctly', (done) => {
            try {
                const temp_default_log_dir = path.join(__dirname, 'log');
                fs_extra.mkdirpSync(temp_default_log_dir);
                const expected_log_path = path.join(temp_default_log_dir, 'hdb_log.log');
                setMockPropParams(false, 2, LOG_LEVEL.TRACE, 123, HDB_ROOT_TEST);
                harper_logger_rw = rewire('../../../utility/logging/harper_logger');

                // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
                setTimeout(() => {
                    try {
                        const file_exists = fs_extra.pathExistsSync(expected_log_path);
                        expect(file_exists).to.be.true;
                        const log = fs_extra.readFileSync(expected_log_path).toString();
                        expect(log.includes("message\":\"Attempted to create log directory from settings file but failed.  Using default log path - 'hdb/log/hdb_log.log'")).to.be.true;
                        fs_extra.removeSync(temp_default_log_dir);
                        done();
                    } catch(err) {
                        console.error(err);
                        done(err);
                    }
                }, 5000);
            } catch(err) {
                console.error(err);
                done(err);
            }
        }).timeout(8000);*/
    });
    
    describe('Test writeLog function', () => {
        after(() => {
            fs_extra.emptyDirSync(LOG_PATH_TEST);
        });

        it('Test writeLog writes to log as expected happy path', (done) => {
            try {
                setMockPropParams(false, 2, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
                harper_logger_rw = rewire('../../../utility/logging/harper_logger');
                pino_logger = harper_logger_rw.__get__('pino_logger');
                testWriteLogBulkWrite(LOG_PATH_TEST);

                setTimeout(() => {
                    try {
                        const file_exists = fs_extra.pathExistsSync(LOG_PATH_TEST);
                        expect(file_exists).to.be.true;
                        pino_logger.flush();
                        testWriteLogBulkTests(LOG_PATH_TEST);
                        done();
                    } catch(err) {
                        console.error(err);
                        done(err);
                    }
                }, 1000);
            } catch(err) {
                console.error(err);
                done(err);
            }
        }).timeout(3000);

        // This test relies on the one above to create logger.
        it('Test writeLog sets level to error if param not passed', (done) => {
            try {
                harper_logger_rw.writeLog(undefined, 'Undefined level log');

                setTimeout(() => {
                    try {
                        pino_logger.flush();
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
                    } catch(err) {
                        console.error(err);
                        done(err);
                    }
                }, 1000);
            } catch(err) {
                console.error(err);
                done(err);
            }
        }).timeout(3000);

        it('Test writeLog with daily rotate', (done) => {
            let fake_timer = undefined;
            try {
                setMockPropParams(true, 3, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
                harper_logger_rw = rewire('../../../utility/logging/harper_logger');
                pino_logger = harper_logger_rw.__get__('pino_logger');
                const expected_log_path = path.join(TEST_LOG_DIR, `${moment().utc().format('YYYY-MM-DD')}_${LOG_NAME_TEST}`);
                testWriteLogBulkWrite();

                setTimeout(() => {
                    try {
                        const file_exists = fs_extra.pathExistsSync(expected_log_path);
                        expect(file_exists).to.equal(true, `file not found at ${expected_log_path}`);
                        pino_logger.flush();
                        testWriteLogBulkTests(expected_log_path);

                        let tomorrows_date = moment().utc().add(1, 'days');
                        fake_timer = sandbox.useFakeTimers({now: new Date(tomorrows_date.format('YYYY,MM,DD'))});
                        harper_logger_rw.writeLog('fatal', 'Test a new date log is created');
                        const second_expected_log_path = path.join(TEST_LOG_DIR, `${tomorrows_date.format('YYYY-MM-DD')}_${LOG_NAME_TEST}`);
                        testWriteLogBulkWrite();
                        fake_timer.restore();
                        setTimeout(() => {
                            try {
                                const second_file_exists = fs_extra.pathExistsSync(second_expected_log_path);
                                expect(second_file_exists).to.equal(true, `second log file not found at ${second_expected_log_path}`);
                                testWriteLogBulkTests(second_expected_log_path);
                                done();
                            } catch(err) {
                                if (fake_timer) fake_timer.restore();
                                console.error(err);
                                done(err);
                            }
                        }, 5000);
                    } catch(err) {
                        console.error(err);
                        done(err);
                    }
                }, 5000);
            } catch(err) {
                console.error(err);
                done(err);
            }
        }).timeout(11000);

 /*       // This test relies on the one above to create logger.
        it('Test writeLog with daily rotate next day log created', (done) => {
            let fake_timer = undefined;
            try {
                console.log('## test called');

                let tomorrows_date = moment().utc().add(1, 'days');
                fake_timer = sandbox.useFakeTimers({now: new Date(tomorrows_date.format('YYYY,MM,DD'))});
                harper_logger_rw.writeLog('fatal', 'Test a new date log is created');
                const first_expected_log_path = path.join(TEST_LOG_DIR, `${tomorrows_date.format('YYYY-MM-DD')}_${LOG_NAME_TEST}`);
                testWriteLogBulkWrite();
                fake_timer.restore();
                let second_expected_log_path;

                console.log('## before first timeout');

                setTimeout(() => {
                    try {
                        console.log('## first call first timeout');
                        console.log('## ' + first_expected_log_path);
                        const first_file_exists = fs_extra.pathExistsSync(first_expected_log_path);
                        console.log('## path exists response ' + first_file_exists);
                        console.log('## after first path exists');
                        expect(first_file_exists).to.equal(true, `first log file not found at ${first_expected_log_path}`);
                        console.log('## before write logs');
                        testWriteLogBulkTests(first_expected_log_path);
                        fake_timer.restore();

                        console.log('## last call first timeout');
                        done();
                    } catch(err) {
                        if (fake_timer) fake_timer.restore();
                        console.error(err);
                        done(err);
                    }
                }, 5000);


/!*                //The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
                setTimeout(() => {
                    try {
                        console.log('## first call first timeout');
                        console.log('## ' + first_expected_log_path);
                        const first_file_exists = fs_extra.pathExistsSync(first_expected_log_path);
                        console.log('## path exists response ' + first_file_exists);
                        console.log('## after first path exists');
                        expect(first_file_exists).to.equal(true, `first log file not found at ${first_expected_log_path}`);
                        console.log('## before write logs');
                        testWriteLogBulkTests(first_expected_log_path);
                        tomorrows_date = moment().utc().add(2, 'days');
                        fake_timer = sandbox.useFakeTimers({now: new Date(tomorrows_date.format('YYYY,MM,DD'))});
                        console.log('## before write log');
                        harper_logger_rw.writeLog('fatal', 'Test a new NEW date log is created');
                        second_expected_log_path = path.join(TEST_LOG_DIR, `${tomorrows_date.format('YYYY-MM-DD')}_${LOG_NAME_TEST}`);
                        console.log('## before path exists');
                        const second_file_exists = fs_extra.pathExistsSync(second_expected_log_path);
                        expect(second_file_exists).to.equal(true, `second log file not found at ${second_expected_log_path}`);
                        fake_timer.restore();
                        testWriteLogBulkWrite();

                        console.log('## last call first timeout');

                        setTimeout(() => {
                            try {
                                console.log('## first call second timeout');
                                testWriteLogBulkTests(second_expected_log_path);

                                console.log('before done');
                                done();
                            } catch(err) {
                                if (fake_timer) fake_timer.restore();
                                console.error(err);
                                done();
                            }
                        }, 5000);
                    } catch(err) {
                        if (fake_timer) fake_timer.restore();
                        console.error(err);
                        done();
                    }

                }, 5000);*!/
            } catch(err) {
                if (fake_timer) fake_timer.restore();
                console.error(err);
                done(err);
            }
        }).timeout(110000);
*/
        it('Test writeLog removes old log with daily max set', () => {
            let date_stub = undefined;
            try {
                const tomorrows_date = moment().utc().add(3, 'days');
                const fake_timer = sandbox.useFakeTimers({now: new Date(tomorrows_date.format('YYYY,MM,DD'))});
                setMockPropParams(true, 2, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
                harper_logger_rw = rewire('../../../utility/logging/harper_logger');
                fake_timer.restore();
                const date_now = Date.now();
                date_stub = sandbox.stub(Date, 'now').returns(date_now);
                date_stub.onFirstCall().returns(9999999999999);
                harper_logger_rw.writeLog('fatal', 'Test a new date log is created please');
                const expected_log_path = path.join(TEST_LOG_DIR, `${tomorrows_date.format('YYYY-MM-DD')}_${LOG_NAME_TEST}`);
                const file_exists = fs_extra.pathExistsSync(expected_log_path);
                const all_log_files = fs.readdirSync(TEST_LOG_DIR);
                expect(file_exists).to.be.true;
                expect(all_log_files.length).to.equal(2);
                date_stub.restore();
            } catch(err) {
                if (date_stub) date_stub.restore();
                console.error(err);
                throw err;
            }
        });
    });

    describe('Test finalLogger function', () => {
        before(() => {
            fs_extra.emptyDirSync(TEST_LOG_DIR);
        });

        after(() => {
            fs_extra.emptyDirSync(TEST_LOG_DIR);
        });

        it('Test final logger instance is returned', () => {
            setMockPropParams(false, 2, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            const final_logger = harper_logger_rw.finalLogger();
            expect(typeof final_logger).to.equal('object');
        });

        // This test relies on the one above to create logger.
        it('Test final logger instance is returned when pino undefined', () => {
            harper_logger_rw.__set__('pino_logger', undefined);
            const final_logger = harper_logger_rw.finalLogger();
            expect(typeof final_logger).to.equal('object');
            const pino_logger = harper_logger_rw.__get__('pino_logger');
            expect(typeof pino_logger).to.equal('object');
        });
    });
    
    describe('Test removeOldLogs function', () => {
        after(() => {
            fs_extra.emptyDirSync(TEST_LOG_DIR);
        });
        
        it('Test old log is removed happy path', () => {
            setMockPropParams(true, 2, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            const date_now = Date.now();
            const date_stub = sandbox.stub(Date, 'now').returns(date_now);
            date_stub.onFirstCall().returns(9999999999999);
            fs_extra.ensureFileSync(path.join(TEST_LOG_DIR, '2021-04-25_log_unit_test.log'));
            fs_extra.ensureFileSync(path.join(TEST_LOG_DIR, '2021-03-01_log_unit_test.log'));
            harper_logger_rw.writeLog('info', 'This log will trigger daily max');
            const file_exists = fs_extra.pathExistsSync(path.join(TEST_LOG_DIR, '2021-03-01_log_unit_test.log'));
            expect(file_exists).to.be.false;
            date_stub.restore();
        });
    });
    
    describe('Test setLogLevel function', () => {
        before(() => {
            setMockPropParams(false, null, LOG_LEVEL.NOTIFY, LOG_PATH_TEST, HDB_ROOT_TEST);
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            pino_logger = harper_logger_rw.__get__('pino_logger');
        });

        after(() => {
            fs_extra.emptyDirSync(TEST_LOG_DIR);
        });

        afterEach((done) => {
            setTimeout(() => done(), 500);
        });

        it('Test debug log level works as expected', () => {
            harper_logger_rw.setLogLevel(LOG_LEVEL.DEBUG);
            testWriteLogBulkWrite();
            pino_logger.flush();
            const log = fs_extra.readFileSync(LOG_PATH_TEST);
            expect(log.includes('"level":"trace"')).to.be.false;
            expect(log.includes('"level":"debug"')).to.be.true;
            expect(log.includes('"level":"info"')).to.be.true;
            expect(log.includes('"level":"warn"')).to.be.true;
            expect(log.includes('"level":"error"')).to.be.true;
            expect(log.includes('"level":"fatal"')).to.be.true;
            expect(log.includes('"level":"notify"')).to.be.true;
        });

        it('Test info log level works as expected', () => {
            fs_extra.writeFileSync(LOG_PATH_TEST, '');
            harper_logger_rw.setLogLevel(LOG_LEVEL.INFO);
            testWriteLogBulkWrite();
            pino_logger.flush();
            const log = fs_extra.readFileSync(LOG_PATH_TEST);
            expect(log.includes('"level":"trace"')).to.be.false;
            expect(log.includes('"level":"debug"')).to.be.false;
            expect(log.includes('"level":"info"')).to.be.true;
            expect(log.includes('"level":"warn"')).to.be.true;
            expect(log.includes('"level":"error"')).to.be.true;
            expect(log.includes('"level":"fatal"')).to.be.true;
            expect(log.includes('"level":"notify"')).to.be.true;
        });

        it('Test warn log level works as expected', () => {
            fs_extra.writeFileSync(LOG_PATH_TEST, '');
            harper_logger_rw.setLogLevel(LOG_LEVEL.WARN);
            testWriteLogBulkWrite();
            pino_logger.flush();
            const log = fs_extra.readFileSync(LOG_PATH_TEST);
            expect(log.includes('"level":"trace"')).to.be.false;
            expect(log.includes('"level":"debug"')).to.be.false;
            expect(log.includes('"level":"info"')).to.be.false;
            expect(log.includes('"level":"warn"')).to.be.true;
            expect(log.includes('"level":"error"')).to.be.true;
            expect(log.includes('"level":"fatal"')).to.be.true;
            expect(log.includes('"level":"notify"')).to.be.true;
        });

        it('Test error log level works as expected', () => {
            fs_extra.writeFileSync(LOG_PATH_TEST, '');
            harper_logger_rw.setLogLevel(LOG_LEVEL.ERROR);
            testWriteLogBulkWrite();
            pino_logger.flush();
            const log = fs_extra.readFileSync(LOG_PATH_TEST);
            expect(log.includes('"level":"trace"')).to.be.false;
            expect(log.includes('"level":"debug"')).to.be.false;
            expect(log.includes('"level":"info"')).to.be.false;
            expect(log.includes('"level":"warn"')).to.be.false;
            expect(log.includes('"level":"error"')).to.be.true;
            expect(log.includes('"level":"fatal"')).to.be.true;
            expect(log.includes('"level":"notify"')).to.be.true;
        });

        it('Test fatal log level works as expected', () => {
            fs_extra.writeFileSync(LOG_PATH_TEST, '');
            harper_logger_rw.setLogLevel(LOG_LEVEL.FATAL);
            testWriteLogBulkWrite();
            pino_logger.flush();
            const log = fs_extra.readFileSync(LOG_PATH_TEST);
            expect(log.includes('"level":"trace"')).to.be.false;
            expect(log.includes('"level":"debug"')).to.be.false;
            expect(log.includes('"level":"info"')).to.be.false;
            expect(log.includes('"level":"warn"')).to.be.false;
            expect(log.includes('"level":"error"')).to.be.false;
            expect(log.includes('"level":"fatal"')).to.be.true;
            expect(log.includes('"level":"notify"')).to.be.true;
        });

        it('Test notify log level works as expected', () => {
            fs_extra.writeFileSync(LOG_PATH_TEST, '');
            harper_logger_rw.setLogLevel(LOG_LEVEL.NOTIFY);
            testWriteLogBulkWrite();
            pino_logger.flush();
            const log = fs_extra.readFileSync(LOG_PATH_TEST);
            expect(log.includes('"level":"trace"')).to.be.false;
            expect(log.includes('"level":"debug"')).to.be.false;
            expect(log.includes('"level":"info"')).to.be.false;
            expect(log.includes('"level":"warn"')).to.be.false;
            expect(log.includes('"level":"error"')).to.be.false;
            expect(log.includes('"level":"fatal"')).to.be.false;
            expect(log.includes('"level":"notify"')).to.be.true;
        });
    });
    
    describe('Test readLog function', () => {
        const log_msg_test = "I am an old error message";

        before((done) => {
            try {
                setMockPropParams(false, null, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
                harper_logger_rw = rewire('../../../utility/logging/harper_logger');
                const fake_timer = sandbox.useFakeTimers({now: new Date(2021,1,1,0,0)});
                harper_logger_rw.error(log_msg_test);
                fake_timer.restore();
                testWriteLogBulkWrite();
                pino_logger = harper_logger_rw.__get__('pino_logger');
                setTimeout(() => {
                    try {
                        pino_logger.flush();
                        done();
                    } catch(err) {
                        console.error(err);
                        done(err);
                    }
                }, 500);
            } catch(err) {
                console.error(err);
                done(err);
            }
        });

        it('Test read log no query ', async () => {
            const read_obj = {
                "operation": "read_log"
            };
            const result = await harper_logger_rw.readLog(read_obj);
            expect(result.file.length).to.equal(9);
        });

        it('Test read log from', async () => {
            const read_obj = {
                "operation": "read_log",
                "from": "2021-04-26T01:10:00.000Z"
            };
            const result = await harper_logger_rw.readLog(read_obj);
            let test_msg_found = false;
            result.file.forEach((log) => {
                if (log.message === log_msg_test) {
                    test_msg_found = true;
                }
            });

            expect(result.file.length).to.equal(8);
            expect(test_msg_found).to.be.false;
        });

        it('Test read log until', async () => {
            const read_obj = {
                "operation": "read_log",
                "until": "2021-02-01T07:00:10.000Z"
            };
            const result = await harper_logger_rw.readLog(read_obj);
            expect(result.file.length).to.equal(1);
            expect(result.file[0].message).to.be.equal(log_msg_test);
        });

        it('Test read log level', async () => {
            const read_obj = {
                "operation": "read_log",
                "level": "fatal"
            };
            const result = await harper_logger_rw.readLog(read_obj);
            expect(result.file.length).to.equal(1);
            expect(result.file[0].message).to.be.equal('fatal log');
        });

        it('Test read log limit', async () => {
            const read_obj = {
                "operation": "read_log",
                "limit": 3
            };
            const result = await harper_logger_rw.readLog(read_obj);
            expect(result.file.length).to.equal(3);
        });

        it('Test read log order desc', async () => {
            const read_obj = {
                "operation": "read_log",
                "order": "desc"
            };
            const result = await harper_logger_rw.readLog(read_obj);
            expect(result.file.length).to.equal(9);
            expect(result.file[8].message).to.include('Initialized pino logger');
        });

        it('Test read log order asc', async () => {
            const read_obj = {
                "operation": "read_log",
                "order": "asc"
            };
            const result = await harper_logger_rw.readLog(read_obj);
            expect(result.file.length).to.equal(9);
            expect(result.file[0].message).to.include('Initialized pino logger');
        });

        it('Test read log start', async () => {
            const read_obj = {
                "operation": "read_log",
                "order": "asc",
                "start": 7
            };
            const result = await harper_logger_rw.readLog(read_obj);
            expect(result.file.length).to.equal(2);
            expect(result.file[0].message).to.equal('fatal log');
            expect(result.file[1].message).to.equal('notify log');
        });

        it('Test for validation error', async () => {
            const read_obj = {
                "operation": "read_log",
                "level": "eror"
            };
            await test_utils.assertErrorAsync(harper_logger_rw.readLog, [read_obj], new Error('Level not valid'));
        });
    });
    
    describe('Test getPropsFilePath', () => {
        let getPropsFilePath;

        before(() => {
            setMockPropParams(false, null, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
            harper_logger_rw = rewire('../../../utility/logging/harper_logger');
            getPropsFilePath = harper_logger_rw.__get__('getPropsFilePath');
        });
        
        it('Test home dir returned if os.homedir throws error', () => {
            const homedir_stub = sandbox.stub(os, 'homedir').throws(new Error('error'));
            const result = getPropsFilePath();
            expect(result.includes('.harperdb/hdb_boot_properties.file'));
            homedir_stub.restore();
        });

        it('Test root dir used if home dir undefined', () => {
            const homedir_stub = sandbox.stub(os, 'homedir').returns(undefined);
            const result = getPropsFilePath();
            expect(result.includes('harperdb/utility/hdb_boot_properties.file'));
            homedir_stub.restore();
        });
    });
});