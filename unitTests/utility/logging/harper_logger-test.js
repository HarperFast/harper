'use strict';

// Note - something in test_utils is calling that logger so it shouldn't be used in this file.
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs-extra');
const rewire = require('rewire');
const hook_std = require('intercept-stdout');
const os = require('os');
const YAML = require('yaml');
const logger = require('../../../utility/logging/logger');

const HARPER_LOGGER_MODULE = '../../../utility/logging/harper_logger';
const LOG_DIR_TEST = 'testLogger';
const LOG_NAME_TEST = 'hdb.log';
const LOG_PROCESS_NAME_TEST = 'unit_tests';
const TEST_LOG_DIR = path.join(__dirname, LOG_DIR_TEST);
const FULL_LOG_PATH_TEST = path.join(TEST_LOG_DIR, LOG_NAME_TEST);
const INSTALL_LOG_LOCATION = path.resolve(__dirname, `../../../logs`);
const LOG_LEVEL = {
	NOTIFY: 'notify',
	FATAL: 'fatal',
	ERROR: 'error',
	WARN: 'warn',
	INFO: 'info',
	DEBUG: 'debug',
	TRACE: 'trace',
};

const LOG_MSGS_TEST = {
	NOTIFY: 'notify log',
	FATAL: 'fatal log',
	ERROR: 'error log',
	WARN: 'warn log',
	INFO: 'info log',
	DEBUG: 'debug log',
	TRACE: 'trace log',
};

function requireUncached(module) {
	delete require.cache[require.resolve(module)];
	return rewire(module);
}

let captured_stdout = '';
let unhook_std;
function capturedStdOutErr() {
	unhook_std = hook_std((data) => {
		captured_stdout += data;
	});
}

function unhookStdOutErr() {
	captured_stdout = '';
	unhook_std();
}

function convertLogToArray(log_path) {
	let messages = [];
	let log = fs.readFileSync(log_path).toString();
	log.replace(/([^ ]+) \[([^\]]+)]: (.+)\n/g, (t, time, tags_string, message) => {
		let tags = tags_string.split(' ');
		messages.push({
			time,
			level: tags.length < 2 ? tags[0] : tags[1],
			tags,
			message,
		});
	});
	return messages;
}

function readTestLog(log_path) {
	return fs.readFileSync(log_path).toString();
}

function logAllTheLevels(harper_logger) {
	harper_logger.trace(LOG_MSGS_TEST.TRACE);
	harper_logger.debug(LOG_MSGS_TEST.DEBUG);
	harper_logger.info(LOG_MSGS_TEST.INFO);
	harper_logger.warn(LOG_MSGS_TEST.WARN);
	harper_logger.error(LOG_MSGS_TEST.ERROR);
	harper_logger.fatal(LOG_MSGS_TEST.FATAL);
	harper_logger.notify(LOG_MSGS_TEST.NOTIFY);
}

function setTestLogConfig(level, config_log_path, to_file, to_stream) {
	return {
		getIn: (param) => {
			switch (true) {
				case param[1] === 'level':
					return level;
				case param[0] === 'logging' && param[1] === 'root':
					return config_log_path;
				case param[1] === 'file':
					return to_file;
				case param[1] === 'stdStreams':
					return to_stream;
			}
		},
	};
}

describe('Test harper_logger module', () => {
	const sandbox = sinon.createSandbox();

	after(() => {
		sandbox.restore();
	});

	describe('Test initLogSettings function', () => {
		const test_error = new Error('no such file or directory test');

		afterEach(() => {
			sandbox.restore();
			sandbox.resetHistory();
		});

		it('Test that all log settings values are initialized if settings file exists', () => {
			sandbox.stub(YAML, 'parseDocument').returns(setTestLogConfig('trace', TEST_LOG_DIR, false, true));
			sandbox.stub(fs, 'readFileSync').returns('foo');
			const harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			const log_to_file = harper_logger.__get__('log_to_file');
			const log_to_stdstreams = harper_logger.__get__('log_to_stdstreams');
			const log_level = harper_logger.__get__('log_level');
			const log_root = harper_logger.__get__('log_root');
			const log_name = harper_logger.__get__('log_name');
			const log_file_path = harper_logger.__get__('log_file_path');

			expect(log_to_file).to.be.false;
			expect(log_to_stdstreams).to.be.true;
			expect(log_level).to.equal('trace');
			expect(log_root).to.eql(TEST_LOG_DIR);
			expect(log_name).to.eql('hdb.log');
			expect(log_file_path).to.eql(path.join(TEST_LOG_DIR, 'hdb.log'));
		});

		it('Test that all log settings initialized via env vars if settings file does not exist', () => {
			const harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			const properties_reader_stub = sandbox.stub().throws(test_error);
			harper_logger.__set__('hdb_properties', undefined);
			harper_logger.__set__('PropertiesReader', properties_reader_stub);
			test_error.code = 'ENOENT';
			process.env.LOG_TO_FILE = 'false';
			process.env.LOG_TO_STDSTREAMS = 'true';
			process.env.LOG_LEVEL = 'notify';
			process.env.LOG_PATH = 'INSTALL_LOG_LOCATION';

			const initLogSettings = harper_logger.__get__('initLogSettings');
			initLogSettings();
			const log_to_file = harper_logger.__get__('log_to_file');
			const log_to_stdstreams = harper_logger.__get__('log_to_stdstreams');
			const log_level = harper_logger.__get__('log_level');
			const log_root = harper_logger.__get__('log_root');

			delete process.env.LOG_TO_FILE;
			delete process.env.LOG_TO_STDSTREAMS;
			delete process.env.LOG_LEVEL;
			delete process.env.LOG_PATH;

			expect(log_to_file).to.be.false;
			expect(log_to_stdstreams).to.be.true;
			expect(log_level).to.equal('notify');
			expect(log_root).to.eql(INSTALL_LOG_LOCATION);
		});

		it('Test that all log settings initialized with default values if settings file does not exist', () => {
			const harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			harper_logger.__set__('hdb_properties', undefined);
			test_error.code = 'ENOENT';
			const properties_reader_stub = sandbox.stub().throws(test_error);
			harper_logger.__set__('PropertiesReader', properties_reader_stub);
			harper_logger.__set__('log_to_file', undefined);
			harper_logger.__set__('log_to_stdstreams', undefined);
			harper_logger.__set__('log_level', undefined);
			harper_logger.__set__('log_root', undefined);

			const initLogSettings = harper_logger.__get__('initLogSettings');
			initLogSettings();
			const log_to_file = harper_logger.__get__('log_to_file');
			const log_to_stdstreams = harper_logger.__get__('log_to_stdstreams');
			const log_level = harper_logger.__get__('log_level');
			const log_path = harper_logger.__get__('log_root');

			expect(log_to_file).to.be.true;
			expect(log_to_stdstreams).to.be.false;
			expect(log_level).to.equal('warn');
			expect(log_path).to.eql(INSTALL_LOG_LOCATION);
		});

		it('Test that if error code is not ENOENT error is handled correctly', () => {
			test_error.code = 'EACCES';
			const harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			const properties_reader_stub = sandbox.stub().throws(test_error);
			harper_logger.__set__('PropertiesReader', properties_reader_stub);
			const error_stub = sandbox.stub();
			const error_rw = harper_logger.__set__('error', error_stub);
			harper_logger.__set__('hdb_properties', undefined);

			const initLogSettings = harper_logger.__get__('initLogSettings');

			let error;
			try {
				initLogSettings();
			} catch (err) {
				error = err;
			}

			expect(error).to.be.instanceof(Error);
			expect(error_stub.firstCall.args[0]).to.equal('Error initializing log settings');
			expect(error_stub.secondCall.args[0]).to.equal(test_error);

			error_rw();
		});
	});

	describe('Test createLogRecord function', () => {
		let createLogRecord_rw;
		let fake_timer;

		before(() => {
			const harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			createLogRecord_rw = harper_logger.__get__('createLogRecord');
			// Fake timer is used so that we can control the date for these test
			fake_timer = sandbox.useFakeTimers({ now: 1538592633675 });
		});

		after(() => {
			fake_timer.restore();
		});

		it('Test record is correctly returned if message is array', () => {
			const result = createLogRecord_rw('info', [LOG_MSGS_TEST.INFO]);
			expect(result).to.equal(`2018-10-03T18:50:33.675Z [main/0] [info]: info log\n`);
		});

		it('Test record is correctly returned if message array has multiple args with object', () => {
			const result = createLogRecord_rw('info', [`${LOG_MSGS_TEST.INFO}:`, { foo: 'bar' }]);
			expect(result).to.equal(`2018-10-03T18:50:33.675Z [main/0] [info]: info log: {"foo":"bar"}\n`);
		});

		it('Test record is correctly returned if called by an instance of an error', () => {
			const test_error = new Error(LOG_MSGS_TEST.INFO);
			const result = createLogRecord_rw('info', [test_error]);
			expect(result).to.equal(`2018-10-03T18:50:33.675Z [main/0] [info]: ${test_error.stack}\n`);
		});

		it('Test record is correctly returned if message is an object', () => {
			const result = createLogRecord_rw('info', [{ foo: 'bar' }]);
			expect(result).to.equal(`2018-10-03T18:50:33.675Z [main/0] [info]: {"foo":"bar"}\n`);
		});
	});

	describe('Test logStdOut and logStdErr functions', () => {
		let harper_logger;
		let logStdOut;
		let logStdErr;
		let append_file_stub;
		const test_log = `2018-10-03T18:50:33.675Z [main/0] [info]: this is a unit test log\n`;

		before(() => {
			harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			logStdOut = harper_logger.__get__('logStdOut');
			logStdErr = harper_logger.__get__('logStdErr');
			harper_logger.__set__('log_to_file', true);
			harper_logger.__set__('log_to_stdstreams', true);
			append_file_stub = sandbox.stub(fs, 'appendFileSync');
		});

		it('Test log is written to log stream and stdout if both params are true', () => {
			capturedStdOutErr();
			logStdOut(test_log);

			expect(captured_stdout).to.eql(test_log);
			expect(append_file_stub.firstCall.args[1]).to.eql(test_log);

			unhookStdOutErr();
		});

		it('Test log is written to log stream and stderr if both params are true', () => {
			capturedStdOutErr();
			logStdErr(test_log);

			expect(captured_stdout).to.eql(test_log);
			expect(append_file_stub.firstCall.args[1]).to.eql(test_log);

			unhookStdOutErr();
		});
	});

	describe.skip('Test notify, fatal, error, warn, info, debug, and trace functions', () => {
		let harper_logger;
		const test_arg_1 = 'Fake logging announcement:';
		const test_arg_2 = { foo: 'bar' };
		const test_message = 'Fake logging announcement: {"foo":"bar"}';
		const date_test = new Date(2021, 1, 1, 0, 0);
		const date_test_string = new Date(date_test).toISOString();
		let expected_log;
		let fake_timer;

		before(() => {
			sandbox.stub(YAML, 'parseDocument').returns(setTestLogConfig('trace', TEST_LOG_DIR, true, true));
			harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			fs.mkdirpSync(TEST_LOG_DIR);
		});

		after(() => {
			try {
				fs.removeSync(TEST_LOG_DIR);
			} catch (e) {}
		});

		afterEach(() => {
			try {
				fs.emptyDirSync(TEST_LOG_DIR);
			} catch (e) {
				//do nothing here windows doesn't like emptying an already empty folder
			}
			harper_logger.__set__('NON_PM2_PROCESS', true);
			sandbox.restore();
		});

		it('Test info log logs to file and stream for non-processManagement process', (done) => {
			harper_logger.createLogFile(LOG_NAME_TEST, LOG_PROCESS_NAME_TEST);
			expected_log = `${LOG_LEVEL.INFO}", "timestamp": "${date_test_string}", "message": "${test_message}"}\n`;
			fake_timer = sandbox.useFakeTimers({ now: date_test });

			harper_logger.info(test_arg_1, test_arg_2);

			// We need to restore the timer here or it will interfere with the setTimeout.
			fake_timer.restore();

			setTimeout(() => {
				const log_json = readTestLog(FULL_LOG_PATH_TEST);
				expect(log_json).to.equal(expected_log);
				done();
			}, 100);
		});

		it('Test info log writes to stdout for processManagement process', () => {
			harper_logger.__set__('NON_PM2_PROCESS', false);
			harper_logger.__set__('process_name', 'unit_tests');
			expected_log = `${date_test_string} [${LOG_LEVEL.INFO}]: ${LOG_MSGS_TEST.INFO}\n`;
			capturedStdOutErr();
			fake_timer = sandbox.useFakeTimers({ now: date_test });
			harper_logger.info(LOG_MSGS_TEST.INFO);

			expect(captured_stdout).to.eql(expected_log);

			fake_timer.restore();
			unhookStdOutErr();
		});

		it('Test trace log logs to file and stream for non-processManagement process', (done) => {
			harper_logger.createLogFile(LOG_NAME_TEST, LOG_PROCESS_NAME_TEST);
			expected_log = `${LOG_LEVEL.TRACE}", "timestamp": "${date_test_string}", "message": "${LOG_MSGS_TEST.TRACE}"}\n`;
			fake_timer = sandbox.useFakeTimers({ now: date_test });
			harper_logger.trace(LOG_MSGS_TEST.TRACE);

			fake_timer.restore();

			setTimeout(() => {
				const log_json = readTestLog(FULL_LOG_PATH_TEST);
				expect(log_json).to.equal(expected_log);
				done();
			}, 100);
		});

		it('Test trace log writes to stdout for processManagement process', () => {
			harper_logger.__set__('NON_PM2_PROCESS', false);
			harper_logger.__set__('process_name', 'unit_tests');
			expected_log = `${LOG_LEVEL.TRACE}", "timestamp": "${date_test_string}", "message": "${LOG_MSGS_TEST.TRACE}"}\n`;
			capturedStdOutErr();
			fake_timer = sandbox.useFakeTimers({ now: date_test });
			harper_logger.trace(LOG_MSGS_TEST.TRACE);

			expect(captured_stdout).to.eql(expected_log);

			fake_timer.restore();
			unhookStdOutErr();
		});

		it('Test error log logs to file and stream for non-processManagement process', (done) => {
			harper_logger.createLogFile(LOG_NAME_TEST, LOG_PROCESS_NAME_TEST);
			expected_log = `${LOG_LEVEL.ERROR}", "timestamp": "${date_test_string}", "message": "${LOG_MSGS_TEST.ERROR}"}\n`;
			fake_timer = sandbox.useFakeTimers({ now: date_test });
			harper_logger.error(LOG_MSGS_TEST.ERROR);

			fake_timer.restore();

			setTimeout(() => {
				const log_json = readTestLog(FULL_LOG_PATH_TEST);
				expect(log_json).to.equal(expected_log);
				done();
			}, 100);
		});

		it('Test error log writes to stdout for processManagement process', () => {
			harper_logger.__set__('NON_PM2_PROCESS', false);
			harper_logger.__set__('process_name', 'unit_tests');
			expected_log = `${LOG_LEVEL.ERROR}", "timestamp": "${date_test_string}", "message": "${LOG_MSGS_TEST.ERROR}"}\n`;
			capturedStdOutErr();
			fake_timer = sandbox.useFakeTimers({ now: date_test });
			harper_logger.error(LOG_MSGS_TEST.ERROR);

			expect(captured_stdout).to.eql(expected_log);

			fake_timer.restore();
			unhookStdOutErr();
		});

		it('Test debug log logs to file and stream for non-processManagement process', (done) => {
			harper_logger.createLogFile(LOG_NAME_TEST, LOG_PROCESS_NAME_TEST);
			expected_log = `${LOG_LEVEL.DEBUG}", "timestamp": "${date_test_string}", "message": "${LOG_MSGS_TEST.DEBUG}"}\n`;
			fake_timer = sandbox.useFakeTimers({ now: date_test });
			harper_logger.debug(LOG_MSGS_TEST.DEBUG);
			fake_timer.restore();

			setTimeout(() => {
				const log_json = readTestLog(FULL_LOG_PATH_TEST);
				expect(log_json).to.equal(expected_log);
				done();
			}, 100);
		});

		it('Test debug log writes to stdout for processManagement process', () => {
			harper_logger.__set__('NON_PM2_PROCESS', false);
			harper_logger.__set__('process_name', 'unit_tests');
			expected_log = `${LOG_LEVEL.DEBUG}", "timestamp": "${date_test_string}", "message": "${LOG_MSGS_TEST.DEBUG}"}\n`;
			capturedStdOutErr();
			fake_timer = sandbox.useFakeTimers({ now: date_test });
			harper_logger.debug(LOG_MSGS_TEST.DEBUG);

			expect(captured_stdout).to.eql(expected_log);

			fake_timer.restore();
			unhookStdOutErr();
		});

		it('Test notify log logs to file and stream for non-processManagement process', (done) => {
			harper_logger.createLogFile(LOG_NAME_TEST, LOG_PROCESS_NAME_TEST);
			expected_log = `${LOG_LEVEL.NOTIFY}", "timestamp": "${date_test_string}", "message": "${LOG_MSGS_TEST.NOTIFY}"}\n`;
			fake_timer = sandbox.useFakeTimers({ now: date_test });
			harper_logger.notify(LOG_MSGS_TEST.NOTIFY);
			fake_timer.restore();

			setTimeout(() => {
				const log_json = readTestLog(FULL_LOG_PATH_TEST);
				expect(log_json).to.equal(expected_log);
				done();
			}, 100);
		});

		it('Test notify log writes to stdout for processManagement process', () => {
			harper_logger.__set__('NON_PM2_PROCESS', false);
			harper_logger.__set__('process_name', 'unit_tests');
			expected_log = `${LOG_LEVEL.NOTIFY}", "timestamp": "${date_test_string}", "message": "${LOG_MSGS_TEST.NOTIFY}"}\n`;
			capturedStdOutErr();
			fake_timer = sandbox.useFakeTimers({ now: date_test });
			harper_logger.notify(LOG_MSGS_TEST.NOTIFY);

			expect(captured_stdout).to.eql(expected_log);

			fake_timer.restore();
			unhookStdOutErr();
		});

		it('Test fatal log logs to file and stream for non-processManagement process', (done) => {
			harper_logger.createLogFile(LOG_NAME_TEST, LOG_PROCESS_NAME_TEST);
			expected_log = `${LOG_LEVEL.FATAL}", "timestamp": "${date_test_string}", "message": "${LOG_MSGS_TEST.FATAL}"}\n`;
			fake_timer = sandbox.useFakeTimers({ now: date_test });
			harper_logger.fatal(LOG_MSGS_TEST.FATAL);
			fake_timer.restore();

			setTimeout(() => {
				const log_json = readTestLog(FULL_LOG_PATH_TEST);
				expect(log_json).to.equal(expected_log);
				done();
			}, 100);
		});

		it('Test fatal log writes to stdout for processManagement process', () => {
			harper_logger.__set__('NON_PM2_PROCESS', false);
			harper_logger.__set__('process_name', 'unit_tests');
			expected_log = `${LOG_LEVEL.FATAL}", "timestamp": "${date_test_string}", "message": "${LOG_MSGS_TEST.FATAL}"}\n`;
			capturedStdOutErr();
			fake_timer = sandbox.useFakeTimers({ now: date_test });
			harper_logger.fatal(LOG_MSGS_TEST.FATAL);

			expect(captured_stdout).to.eql(expected_log);

			fake_timer.restore();
			unhookStdOutErr();
		});

		it('Test warn log logs to file and stream for non-processManagement process', (done) => {
			harper_logger.createLogFile(LOG_NAME_TEST, LOG_PROCESS_NAME_TEST);
			expected_log = `${LOG_LEVEL.WARN}", "timestamp": "${date_test_string}", "message": "${LOG_MSGS_TEST.WARN}"}\n`;
			fake_timer = sandbox.useFakeTimers({ now: date_test });
			harper_logger.warn(LOG_MSGS_TEST.WARN);
			fake_timer.restore();

			setTimeout(() => {
				const log_json = readTestLog(FULL_LOG_PATH_TEST);
				expect(log_json).to.equal(expected_log);
				done();
			}, 100);
		});

		it('Test warn log writes to stdout for processManagement process', () => {
			harper_logger.__set__('NON_PM2_PROCESS', false);
			harper_logger.__set__('process_name', 'unit_tests');
			expected_log = `${LOG_LEVEL.WARN}", "timestamp": "${date_test_string}", "message": "${LOG_MSGS_TEST.WARN}"}\n`;
			capturedStdOutErr();
			fake_timer = sandbox.useFakeTimers({ now: date_test });
			harper_logger.warn(LOG_MSGS_TEST.WARN);

			expect(captured_stdout).to.eql(expected_log);

			fake_timer.restore();
			unhookStdOutErr();
		});
	});

	describe('Test getPropsFilePath function', () => {
		let harper_logger;
		let getPropsFilePath;

		before(() => {
			harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			getPropsFilePath = harper_logger.__get__('getPropsFilePath');
		});

		it('Test home dir returned if os.homedir throws error', () => {
			const homedir_stub = sandbox.stub(os, 'homedir').throws(new Error('error'));
			const exists_sync_stub = sandbox.stub(fs, 'existsSync').returns(true);
			const result = getPropsFilePath();
			expect(result.includes(`.harperdb${path.sep}hdb_boot_properties.file`)).to.be.true;
			homedir_stub.restore();
			exists_sync_stub.restore();
		});

		it('Test root dir used if home dir undefined', () => {
			const homedir_stub = sandbox.stub(os, 'homedir').returns(undefined);
			const result = getPropsFilePath();
			expect(result.includes(`harperdb${path.sep}utility${path.sep}hdb_boot_properties.file`)).to.be.true;
			homedir_stub.restore();
		});
	});

	describe('Test setLogLevel function', () => {
		let harper_logger;
		let close_log_file;

		before(() => {
			sandbox.restore();
			sandbox.stub(YAML, 'parseDocument').returns(setTestLogConfig(LOG_LEVEL.INFO, TEST_LOG_DIR, true, true));
			harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			close_log_file = harper_logger.__get__('closeLogFile');
		});

		beforeEach(() => {
			fs.ensureFileSync(FULL_LOG_PATH_TEST);
		});

		after(() => {
			try {
				fs.removeSync(TEST_LOG_DIR);
			} catch (e) {}
		});

		afterEach(() => {
			try {
				fs.emptyDirSync(TEST_LOG_DIR);
				close_log_file();
			} catch (e) {}
			sandbox.restore();
		});

		it('Test the correct hierarchical logs are logged when level set to trace', (done) => {
			harper_logger.setLogLevel(LOG_LEVEL.TRACE);
			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const logs = convertLogToArray(FULL_LOG_PATH_TEST);
				const expected_log_levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'notify'];
				let pass = false;
				for (const log of logs) {
					if (expected_log_levels.includes(log.level)) {
						pass = true;
						continue;
					}
					pass = false;
					break;
				}

				//expect(pass).to.be.true;
				expect(logs.length).to.equal(7);

				done();
			}, 100);
		});

		it('Test the correct hierarchical logs are logged when level set to debug', (done) => {
			harper_logger.setLogLevel(LOG_LEVEL.DEBUG);
			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const logs = convertLogToArray(FULL_LOG_PATH_TEST);
				const expected_log_levels = ['debug', 'info', 'warn', 'error', 'fatal', 'notify'];
				let pass = false;
				for (const log of logs) {
					if (expected_log_levels.includes(log.level)) {
						pass = true;
						continue;
					}
					pass = false;
					break;
				}

				expect(pass).to.be.true;
				expect(logs.length).to.equal(6);
				done();
			}, 100);
		});

		it('Test the correct hierarchical logs are logged when level set to info', (done) => {
			harper_logger.setLogLevel(LOG_LEVEL.TRACE);
			harper_logger.setLogLevel(LOG_LEVEL.INFO);
			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const logs = convertLogToArray(FULL_LOG_PATH_TEST);
				const expected_log_levels = ['info', 'warn', 'error', 'fatal', 'notify'];
				let pass = false;
				for (const log of logs) {
					if (expected_log_levels.includes(log.level)) {
						pass = true;
						continue;
					}
					pass = false;
					break;
				}

				expect(pass).to.be.true;
				expect(logs.length).to.equal(5);

				done();
			}, 100);
		});

		it('Test the correct hierarchical logs are logged when level set to warn', (done) => {
			harper_logger.setLogLevel(LOG_LEVEL.WARN);
			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const logs = convertLogToArray(FULL_LOG_PATH_TEST);
				const expected_log_levels = ['warn', 'error', 'fatal', 'notify'];
				let pass = false;
				for (const log of logs) {
					if (expected_log_levels.includes(log.level)) {
						pass = true;
						continue;
					}
					pass = false;
					break;
				}

				expect(pass).to.be.true;
				expect(logs.length).to.equal(4);

				done();
			}, 100);
		});

		it('Test the correct hierarchical logs are logged when level set to error', (done) => {
			harper_logger.setLogLevel(LOG_LEVEL.ERROR);
			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const logs = convertLogToArray(FULL_LOG_PATH_TEST);
				const expected_log_levels = ['error', 'fatal', 'notify'];
				let pass = false;
				for (const log of logs) {
					if (expected_log_levels.includes(log.level)) {
						pass = true;
						continue;
					}
					pass = false;
					break;
				}

				expect(pass).to.be.true;
				expect(logs.length).to.equal(3);

				done();
			}, 100);
		});

		it('Test the correct hierarchical logs are logged when level set to fatal', (done) => {
			harper_logger.setLogLevel(LOG_LEVEL.FATAL);
			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const logs = convertLogToArray(FULL_LOG_PATH_TEST);
				const expected_log_levels = ['fatal', 'notify'];
				let pass = false;
				for (const log of logs) {
					if (expected_log_levels.includes(log.level)) {
						pass = true;
						continue;
					}
					pass = false;
					break;
				}

				expect(pass).to.be.true;
				expect(logs.length).to.equal(2);

				done();
			}, 100);
		});

		it('Test the correct hierarchical logs are logged when level set to notify', (done) => {
			harper_logger.setLogLevel(LOG_LEVEL.NOTIFY);
			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const logs = convertLogToArray(FULL_LOG_PATH_TEST);
				const expected_log_levels = ['notify'];
				let pass = false;
				for (const log of logs) {
					if (expected_log_levels.includes(log.level)) {
						pass = true;
						continue;
					}
					pass = false;
					break;
				}

				expect(pass).to.be.true;
				expect(logs.length).to.equal(1);

				done();
			}, 100);
		});
		describe('Test setLogLevel function on conditional logger', () => {
			it('Test the correct hierarchical logs are available when level set to debug', () => {
				logger.setLogLevel(LOG_LEVEL.DEBUG);
				let tagged_logger = logger.loggerWithTag('test');
				let keys = [];
				for (let key in tagged_logger) if (tagged_logger[key] != null) keys.push(key);
				expect(keys).to.deep.equal(['notify', 'fatal', 'error', 'warn', 'info', 'debug']);
			});
			it('Test the correct hierarchical logs are available when level set to warn', () => {
				logger.setLogLevel(LOG_LEVEL.WARN);
				let tagged_logger = logger.loggerWithTag('test');
				let keys = [];
				for (let key in tagged_logger) if (tagged_logger[key] != null) keys.push(key);
				expect(keys).to.deep.equal(['notify', 'fatal', 'error', 'warn']);
			});
			it('Test the correct hierarchical logs are available when level set to fatal', () => {
				logger.setLogLevel(LOG_LEVEL.FATAL);
				let tagged_logger = logger.loggerWithTag('test');
				let keys = [];
				for (let key in tagged_logger) if (tagged_logger[key] != null) keys.push(key);
				expect(keys).to.deep.equal(['notify', 'fatal']);
			});
		});
	});

	describe('Test autoCastBoolean function', () => {
		let harper_logger;
		let autoCastBoolean;

		it('Test boolean returned as boolean', () => {
			harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			autoCastBoolean = harper_logger.__get__('autoCastBoolean');
			const result = autoCastBoolean(false);

			expect(result).to.be.false;
		});

		it('Test "TRUE" string returned as boolean', () => {
			harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			autoCastBoolean = harper_logger.__get__('autoCastBoolean');
			const result = autoCastBoolean('TRUE');

			expect(result).to.be.true;
		});

		it('Test "FalSe" string returned as boolean', () => {
			harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			autoCastBoolean = harper_logger.__get__('autoCastBoolean');
			const result = autoCastBoolean('FalSe');

			expect(result).to.be.false;
		});
	});

	it('Test suppressLogging function', () => {
		const harper_logger = requireUncached(HARPER_LOGGER_MODULE);
		const fake_func = sandbox.stub().callsFake(() => {});
		const enabled_var = harper_logger.__get__('logging_enabled');
		harper_logger.suppressLogging(fake_func);
		expect(enabled_var).to.be.true;
		expect(fake_func.called).to.be.true;
	});
});
