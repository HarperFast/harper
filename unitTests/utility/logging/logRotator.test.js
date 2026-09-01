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
const { pinLogConfig } = require('../../logConfigFixture.js');
const { waitFor } = require('../../waitFor.js');
const LOG_DIR_NAME_TEST = 'testLogger';
const LOG_NAME_TEST = 'hdb.log';
const LOG_DIR_TEST = path.join(__dirname, LOG_DIR_NAME_TEST);
const LOG_FILE_PATH_TEST = path.join(LOG_DIR_TEST, LOG_NAME_TEST);
const TEST_TIMEOUT = 10000;

describe('Test logRotator module', () => {
	let logger;
	let restoreLogConfig;
	async function callLogger() {
		for (let i = 1; i < 21; i++) {
			logger.error('This log is coming from the logRotator unit test. Log number:', i);
		}
		await hdb_utils.asyncSetTimeout(50);
		setTimeout(() => {}, 500);
		fs.statSync(LOG_FILE_PATH_TEST).size;
	}

	before(() => {
		// Every assertion here reads the log file back, and createLogger() only writes one when the
		// logger's config says logging.file is on. Without this the suite depends on the machine
		// having Harper installed: green on a developer box, ENOENT on the log it just wrote
		// everywhere else.
		restoreLogConfig = pinLogConfig({ level: 'error' });
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
		restoreLogConfig?.();
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
		const past = new Date(Date.now() - 7200000);
		fs.utimesSync(oldLog, past, past);

		// Large maxSize so the active log is not rotated; retention is what we are exercising.
		const rotator = log_rotator({
			logger,
			path: retentionDir,
			enabled: true,
			auditInterval: 100,
			maxSize: '1G',
			retention: '1H',
		});
		await hdb_utils.asyncSetTimeout(300);
		rotator.end();

		expect(fs.pathExistsSync(oldLog), 'Rotated log older than retention should be deleted').to.be.false;
		expect(fs.pathExistsSync(newLog), 'Rotated log within retention should be kept').to.be.true;
	}).timeout(TEST_TIMEOUT);

	it('Keeps both archives when two loggers with the same basename rotate into a shared directory at the same instant', async () => {
		// Two distinct source logs sharing a basename (e.g. `/logs/a/hdb.log` and `/logs/b/hdb.log`)
		// is exactly the scenario that used to collide: both computed the same
		// `<basename>-<timestamp>.log` destination when their rotations landed in the same audit
		// tick, and POSIX rename() silently replaced the first archive with the second (#1880).
		// Use a dedicated subdirectory with its own file names, distinct from LOG_FILE_PATH_TEST
		// ('testLogger/hdb.log') and harper_logger.test.js's 'testLogger/external.log' — those
		// paths key the module-global `fileLoggers` map, and reusing them would let unrelated
		// leftover state from other tests bleed into this one.
		const collisionDir = path.join(LOG_DIR_TEST, 'collisionTest');
		const sourceADir = path.join(collisionDir, 'a');
		const sourceBDir = path.join(collisionDir, 'b');
		const sourceALogPath = path.join(sourceADir, 'hdb.log');
		const sourceBLogPath = path.join(sourceBDir, 'hdb.log');
		fs.mkdirpSync(sourceADir);
		fs.mkdirpSync(sourceBDir);
		const sourceALogger = hdb_logger.createLogger({ stdStreams: false, path: sourceALogPath, level: 'error' });
		const sourceBLogger = hdb_logger.createLogger({ stdStreams: false, path: sourceBLogPath, level: 'error' });

		const markerA = 'SOURCE_A_PAYLOAD_MARKER';
		const markerB = 'SOURCE_B_PAYLOAD_MARKER';
		for (let i = 1; i < 21; i++) {
			sourceALogger.error(markerA, i);
			sourceBLogger.error(markerB, i);
		}
		await hdb_utils.asyncSetTimeout(50);

		// Freeze Date.now so both rotators compute the exact same timestamp for their archive
		// filename, reproducing the collision window deterministically instead of depending on
		// real timer alignment (#1880).
		const realDateNow = Date.now;
		const frozenNow = realDateNow();
		Date.now = () => frozenNow;
		const sharedRotatedDir = path.join(collisionDir, 'rotated');
		let sourceARotator, sourceBRotator;
		try {
			sourceARotator = log_rotator({
				logger: sourceALogger,
				path: sharedRotatedDir,
				enabled: true,
				auditInterval: 100,
				maxSize: '1K',
			});
			sourceBRotator = log_rotator({
				logger: sourceBLogger,
				path: sharedRotatedDir,
				enabled: true,
				auditInterval: 100,
				maxSize: '1K',
			});
			// Wait for the actual completion condition (both archives present) instead of a fixed
			// sleep: end() only cancels *future* ticks, it does not await a stat()/rename() already
			// in flight, so a fixed sleep can race that in-flight work and observe only one archive
			// on a loaded runner.
			await waitFor(() => fs.existsSync(sharedRotatedDir) && fs.readdirSync(sharedRotatedDir).length >= 2, {
				timeout: TEST_TIMEOUT - 1000,
				message: 'Expected both sources to have rotated an archive into the shared directory',
			});
		} finally {
			Date.now = realDateNow;
			sourceARotator?.end();
			sourceBRotator?.end();
			sourceALogger.closeLogFile();
			sourceBLogger.closeLogFile();
		}

		const rotatedFiles = fs.readdirSync(sharedRotatedDir);
		assert.strictEqual(
			rotatedFiles.length,
			2,
			`Expected one surviving archive per source log, found: ${rotatedFiles.join(', ')}`
		);
		const contents = rotatedFiles.map((file) => readFileSync(path.join(sharedRotatedDir, file), 'utf-8'));
		assert(
			contents.some((content) => content.includes(markerA)),
			'Expected one archive to contain source A payload'
		);
		assert(
			contents.some((content) => content.includes(markerB)),
			'Expected one archive to contain source B payload'
		);
	}).timeout(TEST_TIMEOUT);
});
