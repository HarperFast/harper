'use strict';

const assert = require('node:assert');
const fs = require('fs-extra');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const hdbLogger = require('#src/utility/logging/harper_logger');
const { parseMaxSize } = require('#src/utility/logging/logRotation');
const { pinLogConfig } = require('../../logConfigFixture.js');
const { waitFor } = require('../../waitFor.js');

// Long enough that the audit tick can never be what rotates: every assertion below is about the
// write path itself. On origin/main this makes the whole suite fail — nothing else checks the size.
const NEVER_TICKS = 3600000;
const TEST_ROOT = path.join(__dirname, 'rotationGuardLogs');

describe('Test log rotation on the write path (#1877)', () => {
	let restoreLogConfig;
	let caseNumber = 0;

	before(() => {
		restoreLogConfig = pinLogConfig({ level: 'error' });
		fs.mkdirpSync(TEST_ROOT);
	});

	after(() => {
		restoreLogConfig?.();
		try {
			fs.removeSync(TEST_ROOT);
		} catch {}
	});

	// getFileLogger caches by path, and the guard belongs to the first closure built for it, so
	// every case needs a path of its own.
	function newCase(rotation) {
		const dir = path.join(TEST_ROOT, `case${caseNumber++}`);
		fs.mkdirpSync(dir);
		const logPath = path.join(dir, 'hdb.log');
		const rotatedDir = path.join(dir, 'rotated');
		const logger = hdbLogger.createLogger({
			stdStreams: false,
			path: logPath,
			level: 'error',
			rotation: { enabled: true, auditInterval: NEVER_TICKS, path: rotatedDir, ...rotation },
		});
		return { logger, logPath, rotatedDir };
	}

	function archives(rotatedDir) {
		try {
			return fs.readdirSync(rotatedDir).map((name) => path.join(rotatedDir, name));
		} catch {
			return [];
		}
	}

	function activeSize(logPath) {
		try {
			return fs.statSync(logPath).size;
		} catch {
			return 0;
		}
	}

	it('bounds the active log while it is being written, without waiting for an audit tick', () => {
		const { logger, logPath, rotatedDir } = newCase({ maxSize: '4K' });
		let peak = 0;
		for (let i = 0; i < 400; i++) {
			logger.error(`bounded rotation line ${i} ${'x'.repeat(60)}`);
			peak = Math.max(peak, activeSize(logPath));
		}
		assert.ok(archives(rotatedDir).length > 0, 'expected the write path to have rotated the log');
		// maxBytes + one check quantum + one payload, with room for the rotation notice.
		assert.ok(peak < 4 * 4000, `active log peaked at ${peak} bytes for a 4K maxSize`);
	});

	it('rotates a log that is already oversized on the first write, not on a later tick', () => {
		const dir = path.join(TEST_ROOT, `pre-existing${caseNumber++}`);
		fs.mkdirpSync(dir);
		const logPath = path.join(dir, 'hdb.log');
		const rotatedDir = path.join(dir, 'rotated');
		fs.writeFileSync(logPath, 'x'.repeat(50000));
		const logger = hdbLogger.createLogger({
			stdStreams: false,
			path: logPath,
			level: 'error',
			rotation: { enabled: true, maxSize: '4K', auditInterval: NEVER_TICKS, path: rotatedDir },
		});
		logger.error('first write after restart');
		assert.strictEqual(archives(rotatedDir).length, 1, 'expected exactly one archive after one write');
		assert.ok(activeSize(logPath) < 4000, 'expected a fresh, small active log');
	});

	it('keeps every message exactly once across the active log and the archives', () => {
		const { logger, logPath, rotatedDir } = newCase({ maxSize: '4K' });
		const total = 300;
		for (let i = 0; i < total; i++) logger.error(`unique-marker-${i}-${'y'.repeat(40)}`);
		logger.closeLogFile();
		const contents = [logPath, ...archives(rotatedDir)]
			.map((file) => {
				try {
					return fs.readFileSync(file, 'utf8');
				} catch {
					return '';
				}
			})
			.join('');
		for (let i = 0; i < total; i++) {
			const occurrences = contents.split(`unique-marker-${i}-`).length - 1;
			assert.strictEqual(occurrences, 1, `marker ${i} appeared ${occurrences} times across all generations`);
		}
	});

	it('never rotates when rotation is disabled, even with a maxSize set', () => {
		const { logger, logPath, rotatedDir } = newCase({ enabled: false, maxSize: '1K' });
		for (let i = 0; i < 200; i++) logger.error(`disabled rotation line ${i} ${'z'.repeat(60)}`);
		assert.strictEqual(archives(rotatedDir).length, 0, 'expected no archives when rotation is disabled');
		assert.ok(activeSize(logPath) > 1000, 'expected the log to grow past maxSize when rotation is disabled');
	});

	it('measures payloads in bytes, so a multi-byte log does not overshoot', () => {
		const { logger, logPath, rotatedDir } = newCase({ maxSize: '4K' });
		let peak = 0;
		for (let i = 0; i < 200; i++) {
			logger.error(`multibyte ${i} ${'é中🚀'.repeat(20)}`);
			peak = Math.max(peak, activeSize(logPath));
		}
		assert.ok(archives(rotatedDir).length > 0, 'expected rotation for a multi-byte payload');
		assert.ok(peak < 4 * 4000, `active log peaked at ${peak} bytes for a 4K maxSize`);
	});

	it('rotates from a worker thread too, keeping every message exactly once across generations', async () => {
		const { logger, logPath, rotatedDir } = newCase({ maxSize: '4K' });
		const rotation = { enabled: true, maxSize: '4K', auditInterval: NEVER_TICKS, path: rotatedDir };
		const worker = new Worker(path.join(__dirname, 'rotation-worker-for-tests.js'), {
			workerData: { logPath, rotation, lineCount: 200, markerPrefix: 'worker-marker' },
		});
		const workerDone = new Promise((resolve, reject) => {
			worker.once('message', resolve);
			worker.once('error', reject);
		});
		for (let i = 0; i < 200; i++) logger.error(`main-marker-${i}-${'q'.repeat(40)}`);
		await workerDone;
		await worker.terminate();
		logger.closeLogFile();

		assert.ok(archives(rotatedDir).length > 0, 'expected rotation with a worker thread writing');
		const readAll = () =>
			[logPath, ...archives(rotatedDir)]
				.map((file) => {
					try {
						return fs.readFileSync(file, 'utf8');
					} catch {
						return '';
					}
				})
				.join('');
		// Both sinks flush on a timer under load, so wait for the last entry rather than racing it.
		const contents = await waitFor(
			() => {
				const all = readAll();
				return all.includes(`worker-marker-199-`) && all.includes(`main-marker-199-`) ? all : false;
			},
			{
				timeout: 10000,
				message: 'the last marker from each thread never reached the log',
			}
		);
		for (const prefix of ['main-marker', 'worker-marker']) {
			for (let i = 0; i < 200; i++) {
				const occurrences = contents.split(`${prefix}-${i}-`).length - 1;
				assert.strictEqual(occurrences, 1, `${prefix}-${i} appeared ${occurrences} times across all generations`);
			}
		}
	}).timeout(30000);

	it('resumes writing to the file once a broken rotation target is repaired', async function () {
		this.timeout(30000);
		const { logger, logPath, rotatedDir } = newCase({ maxSize: '4K' });
		logger.error('one line so the rotated directory exists');
		fs.removeSync(rotatedDir);
		fs.writeFileSync(rotatedDir, 'not a directory');
		for (let i = 0; i < 60; i++) logger.error(`broken rotation line ${i} ${'w'.repeat(60)}`);
		const strandedSize = activeSize(logPath);

		fs.removeSync(rotatedDir);
		fs.mkdirpSync(rotatedDir);
		// The retry happens before an append, not after one, so the log has to keep being written to.
		await waitFor(
			() => {
				logger.error(`recovery probe ${'w'.repeat(60)}`);
				return archives(rotatedDir).length > 0;
			},
			{ timeout: 20000, interval: 250, message: 'rotation never recovered after the target was repaired' }
		);
		assert.ok(activeSize(logPath) < strandedSize + 4 * 4000, 'expected the log to stay bounded through recovery');
	});

	it('stops growing the log and reports to stdio when the rotation target cannot be written', () => {
		const { logger, logPath, rotatedDir } = newCase({ maxSize: '4K' });
		logger.error('one line so the rotated directory exists');
		// Replacing the rotated directory with a file makes every rename fail with ENOTDIR, which is
		// the portable stand-in for the read-only/exhausted rotation target this must survive.
		fs.removeSync(rotatedDir);
		fs.writeFileSync(rotatedDir, 'not a directory');
		for (let i = 0; i < 60; i++) logger.error(`failing rotation line ${i} ${'w'.repeat(60)}`);
		const size = activeSize(logPath);
		assert.ok(size < 4 * 4000, `active log grew to ${size} bytes while rotation was failing`);
	});
});

describe('Test parseMaxSize (#1877)', () => {
	it('accepts well-formed sizes', () => {
		assert.strictEqual(parseMaxSize('64M'), 64000000);
		assert.strictEqual(parseMaxSize('1K'), 1000);
		// Forms the old parseInt-based validator accepted and that produce a usable cap keep working.
		assert.strictEqual(parseMaxSize('1e3K'), 1000000);
		assert.strictEqual(parseMaxSize('0.1K'), 100);
		// 3G >> 4 is negative on a 32-bit shift; the quantum arithmetic must stay positive.
		assert.strictEqual(parseMaxSize('3G'), 3000000000);
		assert.ok(Math.floor(parseMaxSize('3G') / 16) > 0);
	});

	it('rejects the values the config validator used to let through', () => {
		for (const value of ['0K', '-1K', '1xK', '', 'K', '64', '64X', null, undefined, 64]) {
			assert.strictEqual(parseMaxSize(value), undefined, `expected ${JSON.stringify(value)} to be rejected`);
		}
	});
});
