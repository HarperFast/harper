'use strict';

const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs-extra');
const hdb_utils = require('../../../utility/common_utils');
const { readFileSync } = require('fs');
const hdb_logger = require('../../../utility/logging/harper_logger');
const log_rotator = require('../../../utility/logging/logRotator');
const assert = require('assert');
const LOG_DIR_NAME_TEST = 'testLogger';
const LOG_NAME_TEST = 'hdb.log';
const LOG_DIR_TEST = path.join(__dirname, LOG_DIR_NAME_TEST);
const LOG_FILE_PATH_TEST = path.join(LOG_DIR_TEST, LOG_NAME_TEST);
const TEST_TIMEOUT = 10000;
let test_file_size;

describe('Test logRotator module', () => {
	let logger;
	async function callLogger() {
		for (let i = 1; i < 21; i++) {
			logger.error('This log is coming from the logRotator unit test. Log number:', i);
		}
		await hdb_utils.asyncSetTimeout(50);
		setTimeout(() => {}, 500);
		test_file_size = fs.statSync(LOG_FILE_PATH_TEST).size;
	}

	before(() => {
		fs.mkdirpSync(LOG_DIR_TEST);
		logger = hdb_logger.createLogger({
			stdStreams: false,
			path: LOG_FILE_PATH_TEST,
			level: 'error',
		});
	});

	afterEach(() => {
		logger.closeLogFile();
		fs.emptyDirSync(LOG_DIR_TEST);
	});

	after(() => {
		try {
			fs.removeSync(LOG_DIR_TEST);
		} catch (e) {}
	});

	async function runRotator(options) {
		await callLogger();
		let rotator = log_rotator({
			logger,
			path: LOG_DIR_TEST,
			enabled: true,
			auditInterval: 100,
			...options,
		});
		await hdb_utils.asyncSetTimeout(300);
		rotator.end();
		return rotator.getLastRotatedLogPath();
	}

	it('Test that log file is rotated if log has exceeded max size', async () => {
		const rotated_log_path = await runRotator({ maxSize: '1K' });
		assert(fs.statSync(rotated_log_path).size > 2000, 'Test log file should have contents after it is rotated');
		expect(fs.pathExistsSync(LOG_FILE_PATH_TEST), 'Expected to not find test log because rotate should have deleted it')
			.to.be.false;
	}).timeout(TEST_TIMEOUT);

	it('Test that log file is rotated if interval has exceeded its set value', async () => {
		const rotated_log_path = await runRotator({ interval: '0.05s' });
		assert(fs.statSync(rotated_log_path).size > 2000, 'Test log file should have contents after it is rotated');
		expect(fs.pathExistsSync(LOG_FILE_PATH_TEST), 'Expected to not find test log because rotate should have deleted it')
			.to.be.false;
	}).timeout(TEST_TIMEOUT);

	it('Test log is compressed when rotated', async () => {
		const rotated_log_path = await runRotator({ maxSize: '1K', compress: true });
		console.log('rotated log contents', readFileSync(rotated_log_path, 'utf-8'));
		expect(fs.pathExistsSync(LOG_FILE_PATH_TEST), 'Expected to not find test log because rotate should have deleted it')
			.to.be.false;
		expect(fs.pathExistsSync(rotated_log_path)).to.be.true;
	});

	it('Test error logged if max size and interval not defined', async () => {
		let error;
		try {
			await runRotator({});
		} catch (e) {
			error = e;
		}
		expect(error.message).to.equal(
			"'interval' and 'maxSize' are both undefined, to enable logging rotation at least one of these values must be defined in harperdb-config.yaml"
		);
	});

	it('Test error logged if rotation path is undefined', async () => {
		let error;
		try {
			await runRotator({ maxSize: '1K', path: null });
		} catch (e) {
			error = e;
		}
		expect(error.message).to.equal(
			"'logging.rotation.path' is undefined, to enable logging rotation set this value in harperdb-config.yaml"
		);
	});
});
