'use strict';

//const test_utils = require('../../test_utils');
const sinon = require('sinon');
const chai = require('chai');
const path = require('path');
const pino = require('pino');
const mock_require = require('mock-require');
const fs = require('fs-extra');
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

describe('Test harper_logger module', () => {
    const sandbox = sinon.createSandbox();
    let pino_spy = sandbox.spy(pino);

    before(() => {
        setMockPropParams(false, 2, LOG_LEVEL.TRACE, LOG_PATH_TEST, HDB_ROOT_TEST);
        harper_logger_rw = rewire('../../../utility/logging/harper_logger');
    });

    after(() => {
        mock_require.stopAll();
        sandbox.restore();
        rewire('../../../utility/logging/harper_logger');
    });

    describe('Test createLog function', () => {
        after(() => {
            //fs.emptyDirSync(TEST_LOG_DIR);
        });

        it('Test log is create with file name provided', (done) => {
            const file_exists = fs.pathExistsSync(LOG_PATH_TEST);
            expect(file_exists).to.be.true;
            expect(pino_spy.pino.name).to.equal('pino');

            logAllTheLevels();

            // The log buffer gets flushed every 5 seconds so we wait for the flush to happen before reading.
            setTimeout(() => {
                let log = fs.readFileSync(LOG_PATH_TEST).toString();
                testAllTheLevelsLogged(log);

                done();
            }, 6000);
        }).timeout(8000);
        
        it('im a next test', () => {
            //console.log('fds');


            
        });

    });



});