'use strict';

const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs-extra');
const hdb_utils = require('#src/utility/common_utils');
const { readFileSync } = require('fs');
const hdb_logger = require('#src/utility/logging/harper_logger');
const { logRotator: log_rotator } = require('#src/utility/logging/logRotator');
const assert = require('assert');
const LOG_DIR_NAME_TEST = 'testLogger';
const LOG_NAME_TEST = 'hdb.log';
const LOG_DIR_TEST = path.join(__dirname, LOG_DIR_NAME_TEST);
const LOG_FILE_PATH_TEST = path.join(LOG_DIR_TEST, LOG_NAME_TEST);
const TEST_TIMEOUT = 10000;

describe('Test logRotator module', () => {
	let logger;
	async function callLogger() {
		for (let i = 1; i < 21; i++) {
			logger.error('This log is coming from the logRotator unit test. Log number:', i);
		}
		await hdb_utils.asyncSetTimeout(50);
		setTimeout(() => {}, 500);
		fs.statSync(LOG_FILE_PATH_TEST).size;
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
		} catch {}
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

	it('Defaults rotation path to <log dir>/rotated when path is not set', async () => {
		const rotated_log_path = await runRotator({ maxSize: '1K', path: null });
		const expectedDir = path.join(LOG_DIR_TEST, 'rotated');
		expect(rotated_log_path.startsWith(expectedDir)).to.be.true;
		expect(fs.pathExistsSync(rotated_log_path)).to.be.true;
	});

	it('Reopens a fresh log file after rotation so subsequent writes do not go to the rotated file', async () => {
		const rotated_log_path = await runRotator({ maxSize: '1K' });
		expect(fs.pathExistsSync(LOG_FILE_PATH_TEST), 'Active log should have been rotated away').to.be.false;

		// After rotation the descriptor must be closed so the next write opens a brand new hdb.log.
		const marker = 'POST_ROTATION_MARKER_LINE';
		logger.error(marker);
		await hdb_utils.asyncSetTimeout(100);

		expect(fs.pathExistsSync(LOG_FILE_PATH_TEST), 'A new active log file should be created on the next write').to.be
			.true;
		expect(readFileSync(LOG_FILE_PATH_TEST, 'utf-8')).to.include(marker);
		// The rotated file must not receive writes made after rotation (would indicate a stale/leaked descriptor).
		expect(readFileSync(rotated_log_path, 'utf-8')).to.not.include(marker);
	}).timeout(TEST_TIMEOUT);

	it('Deletes rotated logs older than the configured retention', async () => {
		const retentionDir = path.join(LOG_DIR_TEST, 'retained');
		fs.mkdirpSync(retentionDir);
		const oldLog = path.join(retentionDir, 'HDB-old.log');
		const newLog = path.join(retentionDir, 'HDB-new.log');
		fs.writeFileSync(oldLog, 'old rotated log contents');
		fs.writeFileSync(newLog, 'fresh rotated log contents');
		// Age the old log well beyond the retention window (the fresh log stays comfortably inside it).
		const past = new Date(Date.now() - 120000);
		fs.utimesSync(oldLog, past, past);

		// Large maxSize so the active log is not rotated; retention is what we are exercising.
		const rotator = log_rotator({
			logger,
			path: retentionDir,
			enabled: true,
			auditInterval: 100,
			maxSize: '1G',
			retention: '30s',
		});
		await hdb_utils.asyncSetTimeout(300);
		rotator.end();

		expect(fs.pathExistsSync(oldLog), 'Rotated log older than retention should be deleted').to.be.false;
		expect(fs.pathExistsSync(newLog), 'Rotated log within retention should be kept').to.be.true;
	}).timeout(TEST_TIMEOUT);
});
