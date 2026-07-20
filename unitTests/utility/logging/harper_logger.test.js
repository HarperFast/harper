'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs-extra');
const rewire = require('rewire');
const hook_std = require('intercept-stdout');
const os = require('os');
const YAML = require('yaml');
const harperLoggerModule = require('#src/utility/logging/harper_logger');
const { createLogger } = harperLoggerModule;
const { getHttpOptions, handleApplication, logRequest } = require('#src/server/http');
const { ApplicationScope } = require('#src/components/ApplicationScope');
const { waitFor } = require('../../waitFor.js');
const { pinLogConfig } = require('../../logConfigFixture.js');

const HARPER_LOGGER_MODULE = '#js/utility/logging/harper_logger';
const LOG_DIR_TEST = 'testLogger';
const LOG_NAME_TEST = 'hdb.log';
const LOG_PROCESS_NAME_TEST = 'unit_tests';
const TEST_LOG_DIR = path.join(__dirname, LOG_DIR_TEST);
const FULL_LOG_PATH_TEST = path.join(TEST_LOG_DIR, LOG_NAME_TEST);
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

// Snapshot of a stream's .write plus the 'error' listener installStdioGuard() stashes on it.
function captureStdio() {
	return [process.stdout, process.stderr].map((stream) => ({
		stream,
		write: stream.write,
		handler: stream.harperStdioErrorHandler,
	}));
}

function restoreStdio(captured) {
	for (const { stream, write, handler } of captured) {
		stream.write = write;
		if (stream.harperStdioErrorHandler) {
			stream.removeListener('error', stream.harperStdioErrorHandler);
			delete stream.harperStdioErrorHandler;
		}
		if (handler) {
			stream.harperStdioErrorHandler = handler;
			stream.on('error', handler);
		}
	}
}

// Loading this module runs initLogSettings(), which ends in stdioLogging(): that replaces the
// REAL process.stdout/process.stderr .write with a guard closed over this throwaway instance and
// adds an 'error' listener to both. Leaving it installed routes mocha's own reporter writes
// through an instance these tests then deliberately break — and the guard is built to be hostile,
// rethrowing a write error that is not a broken pipe and noop-ing every write after one that is.
// mocha's `dot` and `tap` reporters write with process.stdout.write directly, so that rethrow
// escapes mid-run through the runner's callback chain; `timeout: 0` in .mocharc.json then means
// nothing ever fails the stalled test, the event loop drains, and the process exits 0 having
// printed no epilogue — indistinguishable from a pass. So put the real streams back before
// handing the instance to a test. Tests that need the guard install it on a stream of their own.
function requireUncached(module) {
	const stdio = captureStdio();
	try {
		delete require.cache[require.resolve(module)];
		return rewire(module);
	} finally {
		restoreStdio(stdio);
	}
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

function convertLogToMessages(logs) {
	let messages = [];
	logs.replace(/([^ ]+) \[([^\]]+)]: (.+)\n/g, (t, time, tags_string, message) => {
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
	let restoreLogConfig;

	// Pin the config instead of inheriting whatever Harper install the machine happens to have.
	// The module-level log_to_file that initLogSettings() resolves at load gates every file write
	// in createLogger(), so with no boot properties present the HTTP-logger and global-logger tests
	// below wait forever for a log file nothing is writing, and initLogSettings()'s own test sees
	// undefined settings because the ENOENT path returns before it reads any config at all.
	before(() => {
		restoreLogConfig = pinLogConfig();
	});

	after(() => {
		sandbox.restore();
		restoreLogConfig?.();
	});

	describe('Test initLogSettings function', () => {
		const test_error = new Error('no such file or directory test');
		const afterThisTest = [];

		afterEach(() => {
			while (afterThisTest.length) afterThisTest.pop()();
			sandbox.restore();
			sandbox.resetHistory();
		});

		it('Test that all log settings values are initialized if settings file exists', () => {
			sandbox.stub(YAML, 'parseDocument').returns(setTestLogConfig('trace', TEST_LOG_DIR, false, true));
			sandbox.stub(fs, 'readFileSync').returns('foo');
			const harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			const log_to_file = harper_logger.__get__('log_to_file');
			const log_to_stdstreams = harper_logger.__get__('logToStdstreams');
			const log_level = harper_logger.logLevel;
			const log_root = harper_logger.__get__('logRoot');
			const log_name = harper_logger.__get__('logName');
			const log_file_path = harper_logger.__get__('logFilePath');

			expect(log_to_file).to.be.false;
			expect(log_to_stdstreams).to.be.true;
			expect(log_level).to.equal('trace');
			expect(log_root).to.eql(TEST_LOG_DIR);
			expect(log_name).to.eql('hdb.log');
			expect(log_file_path).to.eql(path.join(TEST_LOG_DIR, 'hdb.log'));
		});

		it('Test that if error code is not ENOENT error is handled correctly', () => {
			// This asserts the path where there is nothing to fall back to, so ROOTPATH has to be
			// absent: initLogSettings() deliberately SWALLOWS a failure to read the boot properties
			// when ROOTPATH names a directory holding a config (which is how pinLogConfig() above
			// works, and how a developer with ROOTPATH exported would run).
			const originalRootPath = process.env.ROOTPATH;
			delete process.env.ROOTPATH;
			afterThisTest.push(() => {
				if (originalRootPath !== undefined) process.env.ROOTPATH = originalRootPath;
			});

			test_error.code = 'EACCES';
			const harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			const properties_reader_stub = sandbox.stub().throws(test_error);
			harper_logger.__set__('PropertiesReader', properties_reader_stub);
			const error_stub = sandbox.stub();
			const error_rw = harper_logger.__set__('error', error_stub);
			harper_logger.__set__('hdbProperties', undefined);

			const initLogSettings = harper_logger.__get__('initLogSettings');

			let error;
			try {
				initLogSettings();
			} catch (err) {
				error = err;
			}

			expect(error, `error should be Error but it is ${JSON.stringify(error)}`).to.be.instanceof(Error);
			expect(error_stub.firstCall.args[0]).to.equal('Error initializing log settings');
			expect(error_stub.secondCall.args[0]).to.equal(test_error);

			error_rw();
		});
	});

	describe('Test createLogRecord function', () => {
		let fake_timer;

		before(() => {
			// Fake timer is used so that we can control the date for these test
			fake_timer = sandbox.useFakeTimers({ now: 1538592633675 });
		});

		after(() => {
			fake_timer.restore();
		});

		it('Test record is correctly returned if message is a string', () => {
			let result;
			const logger = createLogger({ writeToLog: (msg) => (result = msg) });
			logger.info(LOG_MSGS_TEST.INFO);
			expect(result).to.equal(`[main/0] [info]: info log\n`);
		});

		it('Test record is correctly returned if message array has multiple args with object', () => {
			let result;
			const logger = createLogger({ writeToLog: (msg) => (result = msg) });
			logger.info(`${LOG_MSGS_TEST.INFO}:`, { foo: 'bar' });
			expect(result).to.equal(`[main/0] [info]: info log: { foo: 'bar' }\n`);
		});

		it('Test record is correctly returned if called by an instance of an error', () => {
			let result;
			const logger = createLogger({ writeToLog: (msg) => (result = msg) });
			const test_error = new Error(LOG_MSGS_TEST.INFO);
			logger.info(test_error);
			expect(result).to.equal(`[main/0] [info]: ${test_error.stack}\n`);
		});

		it('Test record is correctly returned if message is an object', () => {
			let result;
			const logger = createLogger({ writeToLog: (msg) => (result = msg) });
			logger.info({ foo: 'bar' });
			expect(result).to.equal(`[main/0] [info]: { foo: 'bar' }\n`);
		});

		it('Test record is correctly returned if message is an error with a cause', () => {
			const test_error_cause = new SyntaxError('test cause error');
			test_error_cause.statusCode = 400;
			const test_error = new TypeError('test error', { cause: test_error_cause });
			let result;
			const logger = createLogger({ writeToLog: (msg) => (result = msg) });
			logger.error([test_error]);
			const lines = result.split('\n');
			expect(lines[1]).to.equal('  TypeError: test error');
			expect(lines[2]).to.include(' at '); // stack trace
			let found_caused_by, found_statusCode;
			for (let line of lines) {
				if (line.includes('[cause]: SyntaxError: test cause error')) found_caused_by = true;
				if (line.includes('statusCode: 400')) found_statusCode = true;
			}
			expect(found_caused_by).to.be.true;
			expect(found_statusCode).to.be.true;
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
			} catch {}
		});

		afterEach(() => {
			try {
				fs.emptyDirSync(TEST_LOG_DIR);
			} catch {
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
			harper_logger.__set__('processName', 'unit_tests');
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
			harper_logger.__set__('processName', 'unit_tests');
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
			harper_logger.__set__('processName', 'unit_tests');
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
			harper_logger.__set__('processName', 'unit_tests');
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
			harper_logger.__set__('processName', 'unit_tests');
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
			harper_logger.__set__('processName', 'unit_tests');
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
			harper_logger.__set__('processName', 'unit_tests');
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
			expect(result.endsWith(`${path.sep}utility${path.sep}hdb_boot_properties.file`), result).to.be.true;
			homedir_stub.restore();
		});
	});

	describe('Test setLogLevel function', () => {
		let harper_logger;

		it('Test the correct hierarchical logs are logged when level set to trace', (done) => {
			let logged = '';
			harper_logger = createLogger({
				level: LOG_LEVEL.TRACE,
				writeToLog: (msg) => (logged += msg),
			});
			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const expected_log_levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'notify'];
				let logs = convertLogToMessages(logged);
				for (const log of logs) {
					if (expected_log_levels.includes(log.level)) {
						continue;
					}
					break;
				}

				expect(logs.length).to.equal(7);

				done();
			}, 100);
		});

		it('Test the correct hierarchical logs are logged when level set to debug', (done) => {
			let logged = '';
			harper_logger = createLogger({
				level: LOG_LEVEL.DEBUG,
				writeToLog: (msg) => (logged += msg),
			});
			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const expected_log_levels = ['debug', 'info', 'warn', 'error', 'fatal', 'notify'];
				let pass = false;
				let logs = convertLogToMessages(logged);
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
			let logged = '';
			harper_logger = createLogger({
				level: LOG_LEVEL.INFO,
				writeToLog: (msg) => (logged += msg),
			});
			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const expected_log_levels = ['info', 'warn', 'error', 'fatal', 'notify'];
				let pass = false;
				let logs = convertLogToMessages(logged);
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
			let logged = '';
			harper_logger = createLogger({
				level: LOG_LEVEL.WARN,
				writeToLog: (msg) => (logged += msg),
			});
			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const expected_log_levels = ['warn', 'error', 'fatal', 'notify'];
				let pass = false;
				let logs = convertLogToMessages(logged);
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
			let logged = '';
			harper_logger = createLogger({
				level: LOG_LEVEL.ERROR,
				writeToLog: (msg) => (logged += msg),
			});
			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const expected_log_levels = ['error', 'fatal', 'notify'];
				let pass = false;
				let logs = convertLogToMessages(logged);
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
			let logged = '';
			harper_logger = createLogger({
				level: LOG_LEVEL.FATAL,
				writeToLog: (msg) => (logged += msg),
			});

			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const expected_log_levels = ['fatal', 'notify'];
				let pass = false;
				let logs = convertLogToMessages(logged);
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
			let logged = '';
			harper_logger = createLogger({
				level: LOG_LEVEL.NOTIFY,
				writeToLog: (msg) => (logged += msg),
			});

			logAllTheLevels(harper_logger);

			setTimeout(() => {
				const expected_log_levels = ['notify'];
				let pass = false;
				let logs = convertLogToMessages(logged);
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
				let logger = createLogger({
					level: LOG_LEVEL.DEBUG,
					writeToLog: (_msg) => {},
				});
				let tagged_logger = logger.withTag('test', true);
				let keys = [];
				for (let key in tagged_logger) if (tagged_logger[key] != null) keys.push(key);
				expect(keys).to.deep.equal(['notify', 'fatal', 'error', 'warn', 'info', 'debug']);
				tagged_logger.debug('test');
			});
			it('Test the correct hierarchical logs are available when level set to warn', () => {
				let logger = createLogger({
					level: LOG_LEVEL.WARN,
					writeToLog: (_msg) => {},
				});
				let tagged_logger = logger.withTag('test', true);
				let keys = [];
				for (let key in tagged_logger) if (tagged_logger[key] != null) keys.push(key);
				expect(keys).to.deep.equal(['notify', 'fatal', 'error', 'warn']);
				tagged_logger.warn('test');
			});
			it('Test the correct hierarchical logs are available when level set to fatal', () => {
				let logger = createLogger({
					level: LOG_LEVEL.FATAL,
					writeToLog: (_msg) => {},
				});

				let tagged_logger = logger.withTag('test', true);
				let keys = [];
				for (let key in tagged_logger) if (tagged_logger[key] != null) keys.push(key);
				expect(keys).to.deep.equal(['notify', 'fatal']);
				tagged_logger.fatal('test');
			});
		});
		describe('Test HTTP logger', () => {
			let originalHttpOptions, originalHttpLogOptions, httpLogPath, httpLogger, getRequestIdStub;
			before(() => {
				originalHttpOptions = getHttpOptions();
				httpLogger = harperLoggerModule.forComponent('http');
				const { path: logPath, level, rotation } = httpLogger;
				originalHttpLogOptions = { path: logPath, level, rotation };

				httpLogPath = path.join(TEST_LOG_DIR, 'http.log');
				httpLogger.path = httpLogPath;
				httpLogger.level = 1;

				// Stub getRequestId to avoid dependencies on databases.system
				let requestIdCounter = 1;
				getRequestIdStub = sandbox.stub().callsFake(() => requestIdCounter++);

				handleApplication({
					options: {
						getAll() {
							return {
								logging: {
									id: true,
									timing: true,
									headers: true,
									path: httpLogPath,
								},
							};
						},
						on() {},
					},
				});
			});

			it('Test the correct output from HTTP logger on GET', async () => {
				logRequest(
					{
						method: 'GET',
						url: '/test',
						socket: { encrypted: true },
						httpVersion: '1.1',
						headers: { 'content-type': 'application/json' },
					},
					200,
					getRequestIdStub(),
					3.71
				);

				// Wait for the log to be written
				await waitFor(
					() => fs.existsSync(httpLogPath) && fs.readFileSync(httpLogPath, 'utf8').includes('GET /test HTTPS/1.1')
				);

				const httpLog = fs.readFileSync(httpLogPath, 'utf8');
				expect(httpLog).to.include('GET /test HTTPS/1.1');
				expect(httpLog).to.match(/id: \d+/);
				expect(httpLog).to.include(' 200');
				expect(httpLog).to.include(' 3.71ms');
				expect(httpLog).to.include('type: application/json');
			});
			it('Test the correct output from HTTP logger on POST', async () => {
				logRequest(
					{
						method: 'POST',
						url: '/post-test',
						socket: { encrypted: false },
						httpVersion: 1.1,
						headers: { 'content-type': 'application/json' },
					},
					201,
					getRequestIdStub(),
					5.13
				);

				// Wait for the log to be written
				await waitFor(
					() => fs.existsSync(httpLogPath) && fs.readFileSync(httpLogPath, 'utf8').includes('POST /post-test HTTP/1.1')
				);

				const httpLog = fs.readFileSync(httpLogPath, 'utf8');
				expect(httpLog).to.include('POST /post-test HTTP/1.1');
				expect(httpLog).to.match(/id: \d+/);
				expect(httpLog).to.include(' 201');
				expect(httpLog).to.include(' 5.13ms');
			});
			after(() => {
				handleApplication({
					options: {
						getAll() {
							return originalHttpOptions;
						},
						on() {},
					},
				});
				// Disable rotation before restoring path to clean up the rotator interval
				httpLogger.rotation = { enabled: false };
				fs.unlink(httpLogger.path);
				httpLogger.path = originalHttpLogOptions.path;
				httpLogger.level = originalHttpLogOptions.level;
				httpLogger.rotation = originalHttpLogOptions.rotation;
			});
		});
	});

	describe('Test global logger', () => {
		before(() => {
			this.externalLogger = harperLoggerModule.forComponent('external');
			const { path: logPath, level, rotation } = this.externalLogger;
			this.originalExternalOptions = { path: logPath, level, rotation };

			this.externalLogPath = path.join(TEST_LOG_DIR, 'external.log');
			this.externalLogger.path = this.externalLogPath;
			this.externalLogger.level = 1;
		});
		it('Test using the global logger', async () => {
			harperLoggerModule.externalLogger.warn('Test of the global logger');

			// Wait for the log to be written
			await waitFor(
				() =>
					fs.existsSync(this.externalLogPath) &&
					fs.readFileSync(this.externalLogPath, 'utf8').includes('Test of the global logger')
			);

			const log = fs.readFileSync(this.externalLogPath, 'utf8');
			expect(log).to.include('Test of the global logger');
		});
		it('Test using an application scoped logger', async () => {
			const appScope = new ApplicationScope('test-logging-component', {}, {});
			appScope.logger.warn('Test of an application logger going to the external log');

			// Wait for the log to be written
			await waitFor(
				() =>
					fs.existsSync(this.externalLogPath) &&
					fs
						.readFileSync(this.externalLogPath, 'utf8')
						.includes('Test of an application logger going to the external log')
			);

			const log = fs.readFileSync(this.externalLogPath, 'utf8');
			expect(log).to.include('Test of an application logger going to the external log');
		});
		after(() => {
			// Disable rotation before restoring path to clean up the rotator interval
			this.externalLogger.rotation = { enabled: false };
			fs.unlink(this.externalLogger.path);
			this.externalLogger.path = this.originalExternalOptions.path;
			this.externalLogger.level = this.originalExternalOptions.level;
			this.externalLogger.rotation = this.originalExternalOptions.rotation;
		});
	});

	describe('Test external/component logger rotation inheritance (#1877)', () => {
		const ROTATION_TEST_DIR = path.join(__dirname, 'rotationInheritanceTest');
		let harper_logger, updateLogger;

		beforeEach(() => {
			fs.mkdirpSync(ROTATION_TEST_DIR);
			harper_logger = requireUncached(HARPER_LOGGER_MODULE);
			updateLogger = harper_logger.__get__('updateLogger');
		});

		afterEach(() => {
			// Stop rotator intervals and close file descriptors before removing the directory —
			// the loggers in these tests get their path reassigned (mainLogPath -> externalLogPath),
			// which leaves the public logger's own `.closeLogFile` bound to the wrong (stale) file
			// entry, so close every registered file logger directly via the module's internal map.
			for (const fileLogger of harper_logger.__get__('fileLoggers').values()) {
				fileLogger.rotator?.end();
				fileLogger.closeLogFile?.();
			}
			fs.removeSync(ROTATION_TEST_DIR);
		});

		it('inherits the main rotation config (incl. maxSize) and rotates the external log file when no component rotation is configured', async () => {
			const mainRotation = { enabled: true, maxSize: '1K', auditInterval: 100 };
			const mainLogPath = path.join(ROTATION_TEST_DIR, 'hdb.log');
			const testMainLogger = harper_logger.createLogger({ path: mainLogPath, level: 'info' });
			// Point the module's private `mainLogger` reference (what updateLogger falls back to) at
			// our test main logger, mirroring how updateLogSettings() always has a real mainLogger set.
			harper_logger.__set__('mainLogger', testMainLogger);
			// updateLogSettings() always applies the main logging options (incl. rotation) first,
			// before ever touching the external logger — reproduce that ordering here.
			updateLogger(testMainLogger, { path: mainLogPath, rotation: mainRotation });

			const externalLogger = testMainLogger.forComponent('external');
			const externalLogPath = path.join(ROTATION_TEST_DIR, 'external.log');

			// This is the same call updateLogSettings() makes for `logging.external`: a path of its
			// own, but no rotation block — it must inherit the main rotation, not lose it.
			updateLogger(externalLogger, { path: externalLogPath });

			expect(externalLogger.rotation).to.deep.equal(mainRotation);

			for (let i = 0; i < 30; i++) externalLogger.info('x'.repeat(80));

			const rotatedDir = path.join(ROTATION_TEST_DIR, 'rotated');
			await waitFor(() => fs.pathExistsSync(rotatedDir) && fs.readdirSync(rotatedDir).length > 0, {
				timeout: 5000,
				message: 'Expected the external log to be rotated using the inherited main maxSize',
			});
		});

		it('preserves an explicit component rotation override instead of the inherited main config', () => {
			const mainRotation = { enabled: true, maxSize: '1K' };
			const mainLogPath = path.join(ROTATION_TEST_DIR, 'hdb.log');
			const testMainLogger = harper_logger.createLogger({ path: mainLogPath, level: 'info' });
			harper_logger.__set__('mainLogger', testMainLogger);
			updateLogger(testMainLogger, { path: mainLogPath, rotation: mainRotation });

			const externalLogger = testMainLogger.forComponent('external');
			const override = { enabled: false };
			updateLogger(externalLogger, { path: path.join(ROTATION_TEST_DIR, 'external.log'), rotation: override });

			expect(externalLogger.rotation).to.deep.equal(override);
		});

		it('still allows clearing the main logger rotation itself (no self-referential lock-in)', () => {
			const mainLogPath = path.join(ROTATION_TEST_DIR, 'hdb.log');
			const testMainLogger = harper_logger.createLogger({ path: mainLogPath, level: 'info' });
			harper_logger.__set__('mainLogger', testMainLogger);

			updateLogger(testMainLogger, { path: mainLogPath, rotation: { enabled: true, maxSize: '1K' } });
			expect(testMainLogger.rotation).to.deep.equal({ enabled: true, maxSize: '1K' });

			// A reload with no rotation block at all (logOptions.rotation undefined) must still be
			// able to clear the main logger's own rotation, not fall back to itself and get stuck.
			updateLogger(testMainLogger, { path: mainLogPath });
			expect(testMainLogger.rotation).to.equal(undefined);
		});
	});

	it('Test suppressLogging function', () => {
		const harper_logger = requireUncached(HARPER_LOGGER_MODULE);
		const fake_func = sandbox.stub().callsFake(() => {});
		const enabled_var = harper_logger.__get__('loggingEnabled');
		harper_logger.suppressLogging(fake_func);
		expect(enabled_var).to.be.true;
		expect(fake_func.called).to.be.true;
	});

	describe('Test errorForLog function (#1734)', () => {
		const util = require('util');
		const { errorForLog } = harperLoggerModule;
		// errorForLog returns a lazy wrapper; the logger renders it via util.inspect. Render it the
		// same way (or via String()) to assert on what actually lands in the log.
		const render = (error) => util.inspect(errorForLog(error));

		it('renders the stack (which includes class name and message)', () => {
			const error = new Error('boom');
			const result = render(error);
			expect(result).to.equal(error.stack);
			expect(result).to.include('Error: boom');
		});

		it('does not include own-enumerable properties stashed on the error', () => {
			// Simulates a secret / axios config attached to a thrown Error — must not leak into the log.
			const error = new Error('origin fetch failed');
			error.authorization = 'Bearer super-secret-token';
			error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			const result = render(error);
			expect(result).to.not.include('super-secret-token');
			expect(result).to.not.include('authorization');
		});

		it('appends the cause chain without leaking the cause’s own properties', () => {
			const root = new Error('connection refused');
			root.secret = 'Bearer super-secret-token';
			const error = new Error('origin fetch failed', { cause: root });
			const result = render(error);
			expect(result).to.include('Error: origin fetch failed');
			expect(result).to.include('caused by:');
			expect(result).to.include('Error: connection refused');
			expect(result).to.not.include('super-secret-token');
		});

		it('does not infinitely loop on a cyclic cause chain', () => {
			const a = new Error('a');
			const b = new Error('b', { cause: a });
			a.cause = b; // cycle
			const result = render(a);
			expect(result).to.include('Error: a');
			expect(result).to.include('Error: b');
		});

		it('falls back to "ClassName: message" when there is no stack', () => {
			// A thrown plain object carrying an HTTP status but no stack.
			const thrown = { message: 'not found', status: 404 };
			expect(render(thrown)).to.equal('Object: not found status=404');
		});

		it('surfaces the allowlisted diagnostic properties (code/status/statusCode/errno/syscall)', () => {
			const error = new Error('ENOENT: no such file or directory');
			error.code = 'ENOENT';
			error.errno = -2;
			error.syscall = 'open';
			error.path = '/home/harperdb/hdb/schema/internal.mdb';
			const result = render(error);
			expect(result).to.include('code=ENOENT');
			expect(result).to.include('errno=-2');
			expect(result).to.include('syscall=open');
			// path is deliberately excluded — it can reveal internal filesystem layout.
			expect(result).to.not.include('/home/harperdb');
		});

		it('surfaces status/statusCode without leaking sibling secret properties', () => {
			const error = new Error('request failed');
			error.status = 401;
			error.statusCode = 401;
			error.authorization = 'Bearer super-secret-token';
			const result = render(error);
			expect(result).to.include('status=401');
			expect(result).to.include('statusCode=401');
			expect(result).to.not.include('super-secret-token');
		});

		it('surfaces allowlisted properties on a cause without leaking the cause’s secrets', () => {
			const root = new Error('connection refused');
			root.code = 'ECONNREFUSED';
			root.secret = 'Bearer super-secret-token';
			const error = new Error('origin fetch failed', { cause: root });
			const result = render(error);
			expect(result).to.include('caused by:');
			expect(result).to.include('code=ECONNREFUSED');
			expect(result).to.not.include('super-secret-token');
		});

		it('handles a thrown string', () => {
			expect(render('just a string')).to.equal('just a string');
		});

		it('handles null and undefined without throwing', () => {
			expect(() => render(null)).to.not.throw();
			expect(render(null)).to.equal('null');
			expect(() => render(undefined)).to.not.throw();
			expect(render(undefined)).to.equal('undefined');
		});

		// The sweep for #1734 routes the error arg of two-/multi-arg logger calls
		// (`logger.warn('msg', errorForLog(error))`) through errorForLog too. Node's Console
		// formats its arguments with util.format, applying util.inspect to the wrapper — so
		// util.format reproduces exactly what lands in hdb.log for those call shapes.
		it('does not leak secrets in the two-arg logger form (message + error)', () => {
			const error = new Error('WS connection failed');
			error.hdb_secret = 'Bearer super-secret-token';
			error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			const rendered = util.format('Error in handling WS connection', errorForLog(error));
			expect(rendered).to.include('Error in handling WS connection');
			expect(rendered).to.include('Error: WS connection failed');
			expect(rendered).to.not.include('super-secret-token');
			expect(rendered).to.not.include('hdb_secret');
		});

		it('does not leak secrets in the multi-arg logger form (message + error + trailing data)', () => {
			const error = new Error('decode failed');
			error.authorization = 'Bearer super-secret-token';
			const rendered = util.format('Error decoding record', errorForLog(error), 'data: deadbeef');
			expect(rendered).to.include('Error decoding record');
			expect(rendered).to.include('Error: decode failed');
			expect(rendered).to.include('data: deadbeef');
			expect(rendered).to.not.include('super-secret-token');
			expect(rendered).to.not.include('authorization');
		});
	});

	describe('Test inspectForLog function (harper#1982)', () => {
		const util = require('util');
		const { inspectForLog } = harperLoggerModule;
		// inspectForLog returns a lazy wrapper; render it the same way the logger does.
		const render = (value, options) => util.inspect(inspectForLog(value, options));

		it('renders past Console default depth/array/string limits when given explicit options', () => {
			const value = {
				install_output: {
					lines: [{ manager: 'npm', stream: 'stderr', line: 'npm error boom' }],
				},
			};
			const result = render(value, { depth: 8, maxArrayLength: 250, maxStringLength: 20000 });
			assert.ok(!result.includes('[Object]'));
			assert.ok(result.includes('npm error boom'));
		});

		it('defers rendering until actually stringified (does not compute eagerly)', () => {
			let rendered = false;
			const hostile = {
				get [util.inspect.custom]() {
					rendered = true;
					return () => 'rendered-on-demand';
				},
			};
			const wrapper = inspectForLog(hostile, { depth: 8 });
			assert.strictEqual(rendered, false, 'inspectForLog should not have touched the value yet');
			assert.strictEqual(util.inspect(wrapper), 'rendered-on-demand');
			assert.strictEqual(rendered, true);
		});

		it('never throws, even if the value has a hostile custom inspect hook', () => {
			const hostile = {
				[util.inspect.custom]() {
					throw new Error('formatter boom');
				},
			};
			assert.doesNotThrow(() => render(hostile));
			assert.ok(render(hostile).includes('Unrenderable value'));
			assert.ok(render(hostile).includes('formatter boom'));
		});

		it('never throws on a revoked Proxy', () => {
			const { proxy, revoke } = Proxy.revocable({}, {});
			revoke();
			assert.doesNotThrow(() => render(proxy));
		});

		it('never throws when the custom inspect hook throws a hostile value (a revoked Proxy) instead of an Error', () => {
			const { proxy, revoke } = Proxy.revocable({}, {});
			revoke();
			const hostile = {
				[util.inspect.custom]() {
					throw proxy; // `err instanceof Error` and `String(err)` both throw on a revoked Proxy
				},
			};
			assert.doesNotThrow(() => render(hostile));
			assert.ok(render(hostile).includes('Unrenderable value'));
		});

		it('sanitizes a nested Error at depth instead of exposing its own-enumerable properties raw (#1734)', () => {
			// http_resp_msg is a generic field - a future caller could embed a raw Error several
			// levels deep in it, unlike the known deployComponent shape this was written for.
			const nested_error = new Error('request failed');
			nested_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			const value = { detail: { cause: { error: nested_error } }, other: 'fine' };

			const result = render(value, { depth: 8, maxArrayLength: 250, maxStringLength: 20000 });
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(!result.includes('Authorization'));
			assert.ok(result.includes('Error: request failed'));
			assert.ok(result.includes('fine'));
		});

		it('preserves an enumerable symbol property (e.g. a nested value’s own custom inspect hook)', () => {
			const custom_rendered = { [util.inspect.custom]: () => 'custom-nested-render' };
			const value = { inner: custom_rendered };
			const result = render(value, { depth: 8 });
			assert.ok(result.includes('custom-nested-render'));
		});

		it('sanitizes what a preserved custom inspect hook RETURNS, not just what it is called with - a hook returning a secret-bearing Error must not leak it (#1994 review)', () => {
			// The hook itself runs at real render time, entirely outside this walk, so its return value
			// has never been through deepSanitizeErrors. A hook that hands back a closure-captured Error
			// carrying a secret must still have that Error sanitized before the final util.inspect call
			// renders whatever the hook returned.
			const secret_error = new Error('request failed');
			secret_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			const custom_rendered = { [util.inspect.custom]: () => secret_error };
			const value = { inner: custom_rendered };
			const result = render(value, { depth: 8 });
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(!result.includes('Authorization'));
			assert.ok(result.includes('Error: request failed'));
		});

		it('sanitizes a secret-carrying Error reached a second time through a cycle', () => {
			const nested_error = new Error('request failed');
			nested_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			const value = { error: nested_error };
			value.self = value; // cycle: the second path to `value` must not bypass sanitization

			const result = render(value, { depth: 8, maxArrayLength: 250, maxStringLength: 20000 });
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(result.includes('Error: request failed'));
		});

		it('sanitizes a secret-carrying Error nested inside a Map or Set instead of leaving it raw', () => {
			const nested_error = new Error('request failed');
			nested_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			const value = {
				map: new Map([['cause', nested_error]]),
				set: new Set([nested_error]),
			};
			const result = render(value, { depth: 8 });
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(result.includes('Error: request failed'));
		});

		it('sanitizes a secret-carrying Error held by a class/custom-prototype instance, preserving its class name', () => {
			const nested_error = new Error('request failed');
			nested_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			class Diagnostic {
				constructor(cause) {
					this.cause = cause;
				}
			}
			const value = { diagnostic: new Diagnostic(nested_error) };
			const result = render(value, { depth: 8 });
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(result.includes('Error: request failed'));
			assert.ok(result.includes('Diagnostic'));
		});

		it('renders the rest of a structured payload instead of losing it all when a nested value carries a branded prototype (e.g. URL) the clone cannot safely wear', () => {
			// URL's own properties (href, protocol, ...) are getters on URL.prototype backed by a
			// #private internal slot the sanitized clone never has - restoring URL.prototype onto a
			// stateless clone makes util.inspect throw once it tries to render it via those getters.
			// Without a per-node fallback, that throw happens inside inspectForLog's OWN try/catch,
			// which then replaces the ENTIRE payload with "[Unrenderable value]" - not just the URL
			// field - losing phase/install_output/deployment_id for one nested URL anywhere in the tree.
			const value = {
				phase: 'install',
				target: new URL('https://example.com/path'),
				install_output: { lines: ['step 1 ok', 'step 2 ok'] },
			};
			const result = render(value, { depth: 8 });
			assert.ok(!result.includes('Unrenderable value'));
			assert.ok(result.includes('install'));
			assert.ok(result.includes('step 1 ok'));
			assert.ok(result.includes('step 2 ok'));
		});

		it("never invokes a Proxy prototype's trap while checking whether a branded prototype is safe to wear (#1994 review)", () => {
			// The branded-prototype safety check above (`inspect(result)` on the empty clone) used to
			// run against ANY non-null, non-Object.prototype prototype, including a live Proxy - so a
			// hostile trap (e.g. `get() { while (true) {} }`) would run during what is supposed to be a
			// passive safety probe on the error-logging path, wedging the worker while it tries to log
			// and rethrow the original operation failure. A Proxy prototype must be rejected outright,
			// the same way types.isProxy already gates every other reflection in this file.
			let trap_calls = 0;
			const hostile_proto = new Proxy(
				{},
				{
					get(target, prop) {
						trap_calls++;
						return Reflect.get(target, prop);
					},
				}
			);
			const hostile = Object.create(hostile_proto);
			hostile.detail = 'fine';
			const result = render({ hostile }, { depth: 8 });
			assert.strictEqual(trap_calls, 0, 'a Proxy prototype must never be probed, only rejected');
			assert.ok(result.includes('fine'));
		});

		it("invokes a nested value's custom inspect hook (reached via its branded prototype) at most once - not once during the internal safety probe and again for the real render (#1994 review)", () => {
			// Before the fix, the safety probe called plain `inspect(result)`, which - like any
			// util.inspect call - invokes `[util.inspect.custom]` if the prototype defines one. That ran
			// the class's custom inspector once here (silently, on an empty, still-mid-construction
			// clone) and once more later for the actual render, corrupting a stateful/one-shot
			// inspector's real output on its second call.
			let calls = 0;
			class OneShot {
				[util.inspect.custom]() {
					calls++;
					if (calls > 1) throw new Error('called twice');
					return 'one-shot-rendered';
				}
			}
			const value = { branded: Object.create(OneShot.prototype) };
			const result = render(value, { depth: 8 });
			assert.strictEqual(calls, 1, 'the custom inspector must be invoked exactly once, not probed separately');
			assert.ok(result.includes('one-shot-rendered'));
		});

		it('never invokes an accessor-backed array entry, and never resolves an overridden Map/Set iterator', () => {
			let array_getter_calls = 0;
			const hostile_array = [];
			Object.defineProperty(hostile_array, 0, {
				enumerable: true,
				get() {
					array_getter_calls++;
					return 'should not be called';
				},
			});
			hostile_array.length = 1;

			let iterator_calls = 0;
			const hostile_map = new Map([['key', 'value']]);
			hostile_map[Symbol.iterator] = function* () {
				iterator_calls++;
				yield ['poisoned', 'should not appear'];
			};
			const hostile_set = new Set(['value']);
			hostile_set[Symbol.iterator] = function* () {
				iterator_calls++;
				yield 'poisoned';
			};

			const result = render({ hostile_array, hostile_map, hostile_set }, { depth: 8 });
			assert.strictEqual(array_getter_calls, 0);
			assert.strictEqual(iterator_calls, 0);
			assert.ok(result.includes('[Getter]'));
			assert.ok(!result.includes('should not be called'));
			assert.ok(result.includes("'key' => 'value'"));
			assert.ok(result.includes("'value'"));
			assert.ok(!result.includes('poisoned'));
		});

		it('bounds sanitization breadth instead of visiting every index of a huge sparse array', () => {
			const huge_sparse_array = new Array(0xffffffff - 1); // length only - no actual elements
			const start = process.hrtime.bigint();
			const result = render({ huge_sparse_array }, { depth: 8, maxArrayLength: 250 });
			const elapsed_ms = Number(process.hrtime.bigint() - start) / 1e6;
			assert.ok(elapsed_ms < 2000, 'sanitizing a huge sparse array should stay bounded, not scan its full length');
			assert.ok(result.includes('sanitize budget'));
		});

		it('bounds sanitization breadth for a large Map/Set rather than cloning every entry', () => {
			const huge_map = new Map(Array.from({ length: 10_000 }, (_, i) => [i, i]));
			const huge_set = new Set(Array.from({ length: 10_000 }, (_, i) => i));
			const result = render({ huge_map, huge_set }, { depth: 8, maxArrayLength: 250 });
			assert.ok(result.includes('sanitize budget'));
		});

		it('creates own properties via defineProperty instead of assignment, so an inherited setter or an own `__proto__` key cannot run during sanitization', () => {
			let setter_calls = 0;
			class WithSetter {
				set detail(_v) {
					setter_calls++;
				}
			}
			const secret_error = new Error('request failed');
			secret_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			const with_setter = new WithSetter();
			// Object.defineProperty (unlike `with_setter.detail = secret_error`, which would just
			// invoke the class's setter above) creates an OWN data property that shadows it - the
			// exact shape a real diagnostic payload could produce and the one this test needs.
			Object.defineProperty(with_setter, 'detail', {
				value: secret_error,
				enumerable: true,
				writable: true,
				configurable: true,
			});

			const proto_bomb = {};
			Object.defineProperty(proto_bomb, '__proto__', {
				value: { own_marker: 'PROTO_BOMB_SURVIVED' },
				enumerable: true,
			});

			const result = render({ with_setter, proto_bomb }, { depth: 8 });
			assert.strictEqual(setter_calls, 0);
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(result.includes('Error: request failed'));
			// If sanitization used plain assignment instead of defineProperty, `result['__proto__'] =`
			// would reparent the CLONE instead of creating an own property, silently dropping this
			// marker from the render (a reparented plain object shows no inherited properties).
			assert.ok(result.includes('PROTO_BOMB_SURVIVED'));
		});

		it('leaves built-in container types (Date, Map, Buffer) rendered natively instead of corrupting them', () => {
			const date = new Date('2024-01-01T00:00:00.000Z');
			const map = new Map([['key', 'value']]);
			const buffer = Buffer.from('hi');
			const result = render({ date, map, buffer }, { depth: 8 });
			assert.ok(result.includes('2024-01-01T00:00:00.000Z'));
			assert.ok(result.includes('Map(1)'));
			assert.ok(result.includes('key'));
			assert.match(result, /Buffer\.from\(|<Buffer/);
		});

		it('omits a field whose getter throws instead of letting it fail the whole render', () => {
			const hostile = {};
			Object.defineProperty(hostile, 'poison', {
				enumerable: true,
				get() {
					throw new Error('getter boom');
				},
			});
			const value = { hostile, fine: 'still here' };
			const result = render(value, { depth: 8 });
			assert.ok(!result.includes('Unrenderable value'));
			assert.ok(result.includes('still here'));
		});

		it('never invokes a getter while sanitizing — describes it as [Getter] instead, same as util.inspect’s default', () => {
			let call_count = 0;
			const value = {};
			Object.defineProperty(value, 'lazy', {
				enumerable: true,
				get() {
					call_count++;
					return 'should not be called';
				},
			});
			const result = render({ value, fine: 'still here' }, { depth: 8 });
			assert.strictEqual(call_count, 0);
			assert.ok(result.includes('[Getter]'));
			assert.ok(!result.includes('should not be called'));
			assert.ok(result.includes('still here'));
		});

		it('sanitizes a secret-carrying Error nested inside a VM cross-realm plain object, Map, and Set', () => {
			const vm = require('vm');
			const context = vm.createContext();
			const vm_error = vm.runInContext('new Error("vm request failed")', context);
			vm_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			const vm_plain_object = vm.runInContext('({})', context);
			vm_plain_object.cause = vm_error;
			const vm_map = vm.runInContext('new Map()', context);
			vm_map.set('cause', vm_error);
			const vm_set = vm.runInContext('new Set()', context);
			vm_set.add(vm_error);

			assert.strictEqual(vm_plain_object instanceof Object, false); // different realm's Object constructor
			assert.strictEqual(vm_map instanceof Map, false); // different realm's Map constructor

			const result = render({ vm_plain_object, vm_map, vm_set }, { depth: 8 });
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(result.includes('Error: vm request failed'));
		});

		it('bounds sanitization breadth for a plain object with a huge number of own properties', () => {
			const huge_object = {};
			for (let i = 0; i < 200_000; i++) huge_object[`key_${i}`] = i;
			const start = process.hrtime.bigint();
			const result = render({ huge_object }, { depth: 8, maxArrayLength: 250 });
			const elapsed_ms = Number(process.hrtime.bigint() - start) / 1e6;
			assert.ok(elapsed_ms < 2000, 'sanitizing a wide plain object should stay bounded, not clone every property');
			assert.ok(result.includes('sanitize budget'));
		});

		it('never hands a Promise to inspect() raw, even one resolved with a secret-carrying Error (#1734)', () => {
			const secret_error = new Error('request failed');
			secret_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			const value = { pending_check: Promise.resolve(secret_error) };
			const result = render(value, { depth: 8 });
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(!result.includes('Authorization'));
			assert.ok(result.includes('Promise'));
		});

		it('bounds total sanitize work (containers + primitive leaves), not just container count', () => {
			// Each object has 1 container + 250 primitive fields; the global node budget must count
			// leaves too, or 250 containers * 250 fields could walk ~62,500 values while only
			// registering as 250 against MAX_SANITIZE_NODES.
			const many_small_objects = {};
			for (let i = 0; i < 250; i++) {
				const child = {};
				for (let j = 0; j < 250; j++) child[`f${j}`] = j;
				many_small_objects[`child_${i}`] = child;
			}
			const start = process.hrtime.bigint();
			const result = render(many_small_objects, { depth: 8, maxArrayLength: 250 });
			const elapsed_ms = Number(process.hrtime.bigint() - start) / 1e6;
			assert.ok(elapsed_ms < 2000, 'leaf values must count against the shared node budget too');
			assert.ok(result.includes('sanitize budget'));
		});

		it('never hands a Date, RegExp, WeakMap, or WeakSet to inspect() raw once it carries a secret-bearing expando (#1734)', () => {
			const secret_error = new Error('request failed');
			secret_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };

			const hostile_date = new Date('2024-01-01T00:00:00.000Z');
			hostile_date.cause = secret_error;
			const hostile_regexp = /abc/gi;
			hostile_regexp.cause = secret_error;
			const hostile_weakmap = new WeakMap();
			hostile_weakmap.cause = secret_error;
			const hostile_weakset = new WeakSet();
			hostile_weakset.cause = secret_error;

			const result = render({ hostile_date, hostile_regexp, hostile_weakmap, hostile_weakset }, { depth: 8 });
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(!result.includes('Authorization'));
			// The expando-free common case is untouched: native rendering is still preserved.
			assert.ok(result.includes('2024-01-01T00:00:00.000Z'));
			assert.match(result, /\/abc\/gi/);
		});

		it('still renders a Date/RegExp/WeakMap/WeakSet exactly natively when it has no expando (fast path unaffected)', () => {
			const date = new Date('2024-01-01T00:00:00.000Z');
			const regexp = /abc/gi;
			const result = render({ date, regexp }, { depth: 8 });
			assert.ok(result.includes('2024-01-01T00:00:00.000Z'));
			assert.match(result, /\/abc\/gi/);
		});

		it("reconstructs an expando-bearing RegExp's flags via individual internal-slot getters, never the combined `flags` getter, so a hostile flag-property expando is never invoked (#1994 review)", () => {
			// RegExp.prototype.flags is specified to synthesize its result by reading `this.global`,
			// `this.ignoreCase`, etc as ordinary [[Get]]s on the RegExp instance - unlike the individual
			// flag getters (`global`, `ignoreCase`, ...), which read the internal [[OriginalFlags]] slot
			// directly. A RegExp carrying an expando that shadows one of those names with a hostile
			// getter would have the combined getter invoke it while merely trying to reconstruct a safe
			// copy for logging.
			let trap_calls = 0;
			const hostile_regexp = /abc/gi;
			hostile_regexp.detail = 'fine'; // the expando that routes this into safeOpaqueBuiltinSummary
			Object.defineProperty(hostile_regexp, 'global', {
				get() {
					trap_calls++;
					return true;
				},
			});
			const result = render({ hostile_regexp }, { depth: 8 });
			assert.strictEqual(
				trap_calls,
				0,
				"reconstructing the flags must never read the instance's own `global` property"
			);
			assert.match(result, /\/abc\/gi/);
		});

		it('falls back to a bounded, safe summary (not the raw value) for a Buffer/boxed-primitive carrying a secret-bearing expando (#1734)', () => {
			const secret_error = new Error('request failed');
			secret_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			const hostile_buffer = Buffer.from('hi');
			hostile_buffer.cause = secret_error;
			const hostile_boxed_number = Object.assign(new Number(5), { cause: secret_error });

			const result = render({ hostile_buffer, hostile_boxed_number }, { depth: 8 });
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(!result.includes('Authorization'));
		});

		it('does not additionally invoke a hostile `Symbol.toStringTag` getter on a boxed String while classifying it - only util.inspect’s own native rendering does', () => {
			// util.inspect itself reads Symbol.toStringTag on every value it renders (to decide the
			// display tag), so the getter firing once, from inspect's own native formatting of the
			// final sanitized value, is unavoidable and not what this guards against. What the fix at
			// hasEnumerableOwnProps (types.isStringObject instead of Object.prototype.toString.call)
			// removes is a SECOND invocation from our own classification logic, reached before inspect
			// ever sees the value - i.e. running a hostile getter as a side effect of merely deciding
			// how to sanitize, not of rendering.
			let invoked = 0;
			const makeBoxedString = () => {
				const boxed_string = new String('hi');
				Object.defineProperty(boxed_string, Symbol.toStringTag, {
					get() {
						invoked++;
						return 'String';
					},
				});
				return boxed_string;
			};

			util.inspect(makeBoxedString());
			const baseline = invoked;
			invoked = 0;

			render({ boxed_string: makeBoxedString() }, { depth: 8 });
			assert.strictEqual(invoked, baseline);
		});

		it('never invokes a hostile `Symbol.toStringTag` getter while picking a safe-summary tag for an opaque built-in that actually carries an expando (#1994 review)', () => {
			// The classification test above only exercises an expando-free boxed String, which returns
			// raw before safeOpaqueBuiltinSummary is ever reached. Adding an expando routes it through
			// safeOpaqueBuiltinSummary's tag detection instead, which used to call
			// Object.prototype.toString.call(value) - the exact same class of getter-invocation bug the
			// classification fix above already closed, just in the other place it was still present.
			let invoked = 0;
			const boxed_string = new String('hi');
			Object.defineProperty(boxed_string, Symbol.toStringTag, {
				get() {
					invoked++;
					return 'String';
				},
			});
			boxed_string.detail = 'fine'; // the expando that routes this into safeOpaqueBuiltinSummary
			const result = render({ boxed_string }, { depth: 8 });
			assert.strictEqual(invoked, 0, 'safeOpaqueBuiltinSummary must not read Symbol.toStringTag while picking a label');
			assert.ok(result.includes('String with own properties omitted for safety'));
		});

		it('sanitizes a function’s secret-bearing expando instead of handing the raw function to inspect() (#1734)', () => {
			const secret_error = new Error('request failed');
			secret_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			function hostile_function() {}
			hostile_function.cause = secret_error;

			const result = render({ hostile_function }, { depth: 8 });
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(!result.includes('Authorization'));
			assert.ok(result.includes('Error: request failed'));
		});

		it('still renders a plain function raw when it has no expando (fast path unaffected)', () => {
			function plain_function(a, b) {
				return a + b;
			}
			const result = render({ plain_function }, { depth: 8 });
			assert.ok(result.includes('[Function: plain_function]'));
		});

		it('fails closed for a Proxy whose `ownKeys` trap throws - caught by the isProxy gate before the trap ever runs (#1734)', () => {
			const secret_error = new Error('request failed');
			secret_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			// types.isProxy now recognizes `hostile` and returns a placeholder before any reflection,
			// so the `ownKeys` trap never actually runs (see the dedicated trap-count test below) -
			// this just pins the end-to-end secret-safety outcome for this shape.
			const hostile = new Proxy(
				{ error: secret_error },
				{
					ownKeys() {
						throw new Error('ownKeys boom');
					},
				}
			);
			const result = render({ hostile }, { depth: 8 });
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(!result.includes('Authorization'));
		});

		it('never invokes ANY trap on a nested Proxy - not just a throwing one - and never leaks its target', () => {
			const secret_error = new Error('request failed');
			secret_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			let trap_calls = 0;
			const hostile = new Proxy(
				{ error: secret_error },
				{
					ownKeys() {
						trap_calls++;
						return Reflect.ownKeys({ error: secret_error });
					},
					getPrototypeOf() {
						trap_calls++;
						return Object.prototype;
					},
					get(target, prop) {
						trap_calls++;
						return Reflect.get(target, prop);
					},
				}
			);
			const result = render({ hostile }, { depth: 8 });
			assert.strictEqual(trap_calls, 0, 'no Proxy trap should ever be invoked while sanitizing');
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(!result.includes('Authorization'));
			assert.ok(result.includes('Proxy'));
		});

		it('clamps an unbounded/huge caller-requested maxArrayLength to a hard ceiling instead of scanning the full array', () => {
			const huge_array = new Array(1_000_000).fill(0);
			const start = process.hrtime.bigint();
			const result = render({ huge_array }, { depth: 8, maxArrayLength: Infinity });
			const elapsed_ms = Number(process.hrtime.bigint() - start) / 1e6;
			assert.ok(
				elapsed_ms < 2000,
				'an unbounded requested maxArrayLength must not defeat the sanitize breadth ceiling'
			);
			assert.ok(result.includes('sanitize budget'));
		});

		it('never returns a nested Error unsanitized once the sanitize depth cap is hit (requires a caller-requested depth beyond the cap)', () => {
			const secret_error = new Error('request failed');
			secret_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			let value = secret_error;
			for (let i = 0; i < 25; i++) value = { nested: value };
			const result = render(value, { depth: 30 });
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(!result.includes('Authorization'));
		});

		it('fails closed to a bounded, quick placeholder for a huge Buffer/boxed-String instead of scanning every index - even when expando-free', () => {
			// Above MAX_INDEXED_EXPANDO_CHECK_LENGTH, hasEnumerableOwnProps can't cheaply verify "no
			// expando" (that's the whole point of the size cap - see its doc comment), so it fails
			// CLOSED: a huge Buffer/boxed-String is treated as if it has an expando even when it does
			// not, trading native-format fidelity (only above this size) for never scanning it and
			// never guessing "clean" on data it didn't actually check.
			const huge_buffer = Buffer.alloc(1_000_000);
			const huge_boxed_string = new String('x'.repeat(1_000_000));
			const start = process.hrtime.bigint();
			const result = render({ huge_buffer, huge_boxed_string }, { depth: 8 });
			const elapsed_ms = Number(process.hrtime.bigint() - start) / 1e6;
			assert.ok(elapsed_ms < 500, 'failing closed above the size cap must not scan every element/character');
			assert.ok(!/Buffer\.from\(|<Buffer/.test(result));
			assert.ok(result.includes('with own properties omitted for safety'));
		});

		it('still resolves a small expando-free Buffer/boxed-String natively (below the size cap, fast path unaffected)', () => {
			const small_buffer = Buffer.from('hi');
			const small_boxed_string = new String('hi');
			const result = render({ small_buffer, small_boxed_string }, { depth: 8 });
			assert.match(result, /Buffer\.from\(|<Buffer/);
			assert.ok(result.includes('hi'));
		});

		it('fails closed (safe summary, not raw) for a Buffer just over the size cap that actually carries an expando', () => {
			const secret_error = new Error('request failed');
			secret_error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			const hostile_buffer = Buffer.alloc(10_001);
			hostile_buffer.cause = secret_error;
			const result = render({ hostile_buffer }, { depth: 8 });
			assert.ok(!result.includes('super-secret-token'));
			assert.ok(!result.includes('Authorization'));
		});
	});

	describe('Test isErrorLike function (harper#1982)', () => {
		const { isErrorLike } = harperLoggerModule;

		it('recognizes a same-realm Error', () => {
			assert.strictEqual(isErrorLike(new Error('boom')), true);
		});

		it('recognizes a cross-realm (VM-created) Error', () => {
			const vm = require('vm');
			const vmError = vm.runInNewContext('new Error("vm boom")');
			assert.strictEqual(vmError instanceof Error, false); // different realm's Error constructor
			assert.strictEqual(isErrorLike(vmError), true);
		});

		it('does not recognize a plain object', () => {
			assert.strictEqual(isErrorLike({ message: 'not an error' }), false);
		});

		it('does not throw and returns false for a revoked Proxy', () => {
			const { proxy, revoke } = Proxy.revocable(new Error('gone'), {});
			revoke();
			assert.doesNotThrow(() => isErrorLike(proxy));
			assert.strictEqual(isErrorLike(proxy), false);
		});

		it("never invokes a live (non-revoked) Proxy's getPrototypeOf trap - `instanceof` would otherwise trigger it", () => {
			let trap_calls = 0;
			const hostile = new Proxy(new Error('gone'), {
				getPrototypeOf(target) {
					trap_calls++;
					return Reflect.getPrototypeOf(target);
				},
			});
			assert.strictEqual(isErrorLike(hostile), false);
			assert.strictEqual(trap_calls, 0, 'isErrorLike must classify a Proxy without reflecting on it at all');
		});

		it("never invokes a Proxy ANCESTOR's getPrototypeOf trap either, even when the argument itself is an ordinary (non-Proxy) object (#1994 review)", () => {
			// types.isProxy(arg) alone only rejects `arg` itself being a Proxy. `arg instanceof Error`
			// walks the FULL prototype chain via [[GetPrototypeOf]] - for
			// `Object.create(Object.create(proxyAncestor))`, `arg` is an ordinary object, but the walk
			// still reaches `proxyAncestor` a couple of levels up and invokes its trap.
			let trap_calls = 0;
			const proxy_ancestor = new Proxy(Error.prototype, {
				getPrototypeOf(target) {
					trap_calls++;
					return Reflect.getPrototypeOf(target);
				},
			});
			const hostile = Object.create(Object.create(proxy_ancestor));
			assert.strictEqual(isErrorLike(hostile), false);
			assert.strictEqual(
				trap_calls,
				0,
				'isErrorLike must not walk the prototype chain at all - a Proxy anywhere in it must never be reflected on'
			);
		});
	});

	describe('Test isStdioBrokenError + disableStdio (harper#2106)', () => {
		const { isStdioBrokenError } = harperLoggerModule;

		it('recognizes a closed pipe error (EPIPE)', () => {
			assert.strictEqual(isStdioBrokenError({ code: 'EPIPE' }), true);
		});

		it('recognizes a closed terminal error (EIO)', () => {
			assert.strictEqual(isStdioBrokenError({ code: 'EIO' }), true);
		});

		it('recognizes a destroyed stream error (ERR_STREAM_DESTROYED)', () => {
			assert.strictEqual(isStdioBrokenError({ code: 'ERR_STREAM_DESTROYED' }), true);
		});

		it('does not misclassify unrelated errors', () => {
			assert.strictEqual(isStdioBrokenError({ code: 'ECONNRESET' }), false);
			assert.strictEqual(isStdioBrokenError(new Error('boom')), false);
			assert.strictEqual(isStdioBrokenError(null), false);
			assert.strictEqual(isStdioBrokenError(undefined), false);
		});

		describe('the process.stdout/stderr.write() wrapper installed by stdioLogging() (harper#2106)', () => {
			let harper_logger;

			// These tests drive installStdioGuard() against FAKE streams, never the real
			// process.stdout/process.stderr, and that is load-bearing rather than tidiness.
			//
			// The guard is meant to be hostile: it rethrows a write error that is not a broken-pipe
			// error, and after a broken-pipe one it routes every later write to a noop. Installed on
			// the real streams and left there for the duration of a test, that lands on mocha's own
			// reporter. `dot` and `tap` write with process.stdout.write directly, so the rethrow
			// escapes mid-run through the runner's callback chain; `timeout: 0` in .mocharc.json
			// then means nothing ever fails the stalled test, the event loop drains, and the process
			// exits 0 having printed no epilogue and no failure — a silent pass. (`spec` and `min`
			// survived it only because Node's console.* swallows stream write errors, and they still
			// lost the reporter lines for the broken-pipe tests to the noop.)
			//
			// installStdioGuard() takes the stream as a parameter, so the same code under test runs
			// with the assertions pointed at a stream mocha is not holding.
			function makeFakeStream() {
				const stream = new EventEmitter();
				// Stands in for the pristine process.std*.write the guard replaces. The guard never
				// calls it — it calls the module's nativeStdWrite — so make it a tripwire: a write that
				// reaches it means the guard was not installed, and the tests below would otherwise
				// pass vacuously.
				stream.write = function unguardedWrite() {
					throw new Error('installStdioGuard() did not replace the write on this stream');
				};
				return stream;
			}

			// Drives stdioLogging()'s guard directly via rewire rather than through
			// initLogSettings()'s real-filesystem config resolution, which made
			// log_to_file/logConsole depend on whatever boot properties happen to exist on the
			// machine running this.
			function setup(logToFile) {
				harper_logger = requireUncached(HARPER_LOGGER_MODULE);
				harper_logger.__set__('log_to_file', logToFile);
				harper_logger.__set__('logConsole', true);
				// Nothing in these tests should reach the real stdout; if a write escapes the stubs
				// below, capture it here rather than letting it interleave with mocha's output.
				harper_logger.__set__('nativeStdWrite', sinon.stub().returns(true));
				// logConsole above makes the guard tee to writeToLogFile, which is only assigned when
				// the resolved config gives the logger a path. Stub it so the tee is exercised here on
				// any machine rather than throwing 'writeToLogFile is not a function'.
				harper_logger.__set__('writeToLogFile', sinon.stub());
				const installStdioGuard = harper_logger.__get__('installStdioGuard');
				const fakeStdout = makeFakeStream();
				const fakeStderr = makeFakeStream();
				installStdioGuard(fakeStdout);
				installStdioGuard(fakeStderr);
				return { fakeStdout, fakeStderr };
			}

			for (const logToFile of [true, false]) {
				it(`catches a broken-pipe write inline instead of throwing, regardless of logging.file:${logToFile}`, () => {
					const { fakeStdout, fakeStderr } = setup(logToFile);
					harper_logger.__set__('nativeStdWrite', function () {
						throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
					});

					assert.doesNotThrow(() => fakeStderr.write('boom\n'));
					// the write above disabled stdio itself - a second, independent write is silent too
					assert.doesNotThrow(() => fakeStdout.write('still fine\n'));

					const callback = sinon.stub();
					assert.strictEqual(fakeStdout.write('chunk', callback), true);
					assert.strictEqual(callback.calledOnce, true);
				});
			}

			it('does not swallow a write error unrelated to a broken stdio stream', () => {
				const { fakeStderr } = setup(true);
				harper_logger.__set__('nativeStdWrite', function () {
					throw Object.assign(new Error('boom'), { code: 'SOMETHING_ELSE' });
				});

				assert.throws(() => fakeStderr.write('boom\n'), /boom/);
			});

			it('keeps teeing console output to the log file after a broken pipe disables the native writer', () => {
				const { fakeStderr } = setup(true);
				const writeToLogFileSpy = sinon.stub();
				harper_logger.__set__('writeToLogFile', writeToLogFileSpy);
				harper_logger.__set__('nativeStdWrite', function () {
					throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
				});

				fakeStderr.write('first write, breaks the pipe\n');
				fakeStderr.write('second write, should still reach the file\n');

				assert.strictEqual(writeToLogFileSpy.callCount, 2);
				assert.strictEqual(writeToLogFileSpy.secondCall.args[0], 'second write, should still reach the file');
			});

			// installStdioGuard() stashes its 'error' listener on the stream itself; calling it
			// directly (rather than fakeStderr.emit('error', ...)) keeps the assertion on the
			// handler rather than on EventEmitter's unhandled-'error' behaviour.
			it('catches the ASYNC error event a real closed pipe emits - not just a synchronous write throw', () => {
				const { fakeStderr } = setup(true);
				const handler = fakeStderr.harperStdioErrorHandler;
				assert.strictEqual(typeof handler, 'function');

				assert.doesNotThrow(() => handler(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));

				// disableStdio() ran as a side effect - the native writer is now the noop, so it no
				// longer throws and still honors a trailing callback
				const callback = sinon.stub();
				assert.strictEqual(harper_logger.__get__('nativeStdWrite')('probe', callback), true);
				assert.strictEqual(callback.calledOnce, true);
			});

			it('the async error handler rethrows an error unrelated to a broken stdio stream', () => {
				const { fakeStderr } = setup(true);
				const handler = fakeStderr.harperStdioErrorHandler;

				assert.throws(() => handler(Object.assign(new Error('boom'), { code: 'SOMETHING_ELSE' })), /boom/);
			});

			// The wiring the tests above deliberately do not exercise on the real streams: that
			// stdioLogging() guards both of them. Safe to run there because it only installs the
			// pass-through guard - no write is made to throw or to noop - and it is undone
			// immediately.
			it('stdioLogging() installs the guard, and its error listener, on both real process streams', () => {
				const captured = captureStdio();
				try {
					harper_logger = requireUncached(HARPER_LOGGER_MODULE);
					harper_logger.__get__('stdioLogging')();

					for (const { stream, write } of captured) {
						assert.notStrictEqual(stream.write, write);
						assert.strictEqual(typeof stream.harperStdioErrorHandler, 'function');
					}
				} finally {
					restoreStdio(captured);
				}
			});
		});
	});

	describe('Test logger auto-wrap of Error args (#1734)', () => {
		// The HarperLogger level methods route every Error argument through errorForLog before
		// Console formatting, so raw `logger.error(error)` calls anywhere in the codebase (or in
		// component/app code) cannot leak own-enumerable props into the log.
		function createCapturingLogger(level = 'trace') {
			const lines = [];
			const logger = harperLoggerModule.createLogger({ level, writeToLog: (line) => lines.push(line) });
			return { logger, lines };
		}

		it('wraps a raw Error passed as the sole argument', () => {
			const { logger, lines } = createCapturingLogger();
			const error = new Error('origin fetch failed');
			error.hdb_secret = 'Bearer super-secret-token';
			error.config = { headers: { Authorization: 'Bearer super-secret-token' } };
			logger.error(error);
			const output = lines.join('\n');
			expect(output).to.include('Error: origin fetch failed');
			expect(output).to.not.include('super-secret-token');
			expect(output).to.not.include('hdb_secret');
		});

		it('wraps a raw Error in any argument position, leaving other args intact', () => {
			const { logger, lines } = createCapturingLogger();
			const error = new Error('WS connection failed');
			error.authorization = 'Bearer super-secret-token';
			logger.warn('Error in handling WS connection', error, 'port: 9926');
			const output = lines.join('\n');
			expect(output).to.include('Error in handling WS connection');
			expect(output).to.include('Error: WS connection failed');
			expect(output).to.include('port: 9926');
			expect(output).to.not.include('super-secret-token');
		});

		it('preserves the cause chain of an auto-wrapped Error', () => {
			const { logger, lines } = createCapturingLogger();
			const root = new Error('connection refused');
			root.secret = 'Bearer super-secret-token';
			logger.error(new Error('origin fetch failed', { cause: root }));
			const output = lines.join('\n');
			expect(output).to.include('caused by:');
			expect(output).to.include('Error: connection refused');
			expect(output).to.not.include('super-secret-token');
		});

		it('does not alter non-Error object arguments', () => {
			const { logger, lines } = createCapturingLogger();
			logger.info('operation summary', { operation: 'insert', records: 3 });
			const output = lines.join('\n');
			expect(output).to.include('operation summary');
			expect(output).to.include('insert');
			expect(output).to.include('records');
		});

		it('applies on every level method, including below-gate no-ops', () => {
			const { logger, lines } = createCapturingLogger('error');
			const error = new Error('quiet');
			error.secret = 'Bearer super-secret-token';
			logger.trace(error); // gated out - must not write at all
			expect(lines).to.have.length(0);
			for (const level of ['error', 'fatal', 'notify']) {
				logger[level](error);
			}
			const output = lines.join('\n');
			expect(output).to.include('Error: quiet');
			expect(output).to.not.include('super-secret-token');
		});

		it('covers loggerWithTag-derived loggers', () => {
			const { logger, lines } = createCapturingLogger();
			const tagged = harperLoggerModule.loggerWithTag('operation', false, logger);
			const error = new Error('op failed');
			error.hdb_secret = 'Bearer super-secret-token';
			tagged.error(error);
			const output = lines.join('\n');
			expect(output).to.include('Error: op failed');
			expect(output).to.not.include('super-secret-token');
		});

		it('covers the inherited Console methods (log/dir/table)', () => {
			const { logger, lines } = createCapturingLogger();
			const error = new Error('bypass attempt');
			error.hdb_secret = 'Bearer super-secret-token';
			logger.log(error);
			logger.dir(error);
			logger.table([error]);
			const output = lines.join('\n');
			expect(output).to.include('Error: bypass attempt');
			expect(output).to.not.include('super-secret-token');
		});

		it('does not throw on a revoked Proxy argument', () => {
			const { logger, lines } = createCapturingLogger();
			const { proxy, revoke } = Proxy.revocable(new Error('gone'), {});
			revoke();
			expect(() => logger.error('operation failed', proxy)).to.not.throw();
			expect(lines.join('\n')).to.include('operation failed');
		});

		it('does not leak a secret through a live (non-revoked) Proxy wrapping an Error (#1734)', () => {
			const { logger, lines } = createCapturingLogger();
			const error = new Error('origin fetch failed');
			error.hdb_secret = 'Bearer super-secret-token';
			const proxy = new Proxy(error, {});
			logger.error(proxy);
			logger.dir(proxy);
			logger.table([proxy]);
			const output = lines.join('\n');
			assert.ok(!output.includes('super-secret-token'));
			assert.ok(!output.includes('hdb_secret'));
		});

		it('does not throw when a revoked Proxy appears as a cause', () => {
			const { logger, lines } = createCapturingLogger();
			const { proxy, revoke } = Proxy.revocable(new Error('root cause'), {});
			revoke();
			const error = new Error('origin fetch failed', { cause: proxy });
			expect(() => logger.error(error)).to.not.throw();
			expect(lines.join('\n')).to.include('Error: origin fetch failed');
		});

		it('does not throw when a cause has a throwing getter', () => {
			const { logger, lines } = createCapturingLogger();
			const hostileCause = {};
			Object.defineProperty(hostileCause, 'stack', {
				get() {
					throw new Error('getter boom');
				},
			});
			const error = new Error('origin fetch failed', { cause: hostileCause });
			expect(() => logger.error(error)).to.not.throw();
			expect(lines.join('\n')).to.include('Error: origin fetch failed');
		});

		it("does not throw when a cause's stack getter throws a revoked Proxy instead of a normal value (#1994 review)", () => {
			// `err instanceof Error`/`String(err)` (the old catch-block rendering) both throw on a
			// revoked Proxy - so if the value thrown by a hostile getter here IS one, the old code's own
			// error-recovery path would itself throw, escaping renderErrorLine entirely.
			const { logger, lines } = createCapturingLogger();
			const { proxy, revoke } = Proxy.revocable({}, {});
			revoke();
			const hostileCause = {};
			Object.defineProperty(hostileCause, 'stack', {
				get() {
					throw proxy;
				},
			});
			const error = new Error('origin fetch failed', { cause: hostileCause });
			assert.doesNotThrow(() => logger.error(error));
			assert.ok(lines.join('\n').includes('Error: origin fetch failed'));
		});
	});
});
