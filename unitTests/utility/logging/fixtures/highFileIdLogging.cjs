'use strict';

// Log-generation identity on a volume whose 64-bit file IDs are past 2^53 — NTFS, once an MFT record
// has been reused 32 times — where a Number stat rounds neighbouring files to one value. Each file
// here reports 2^70 plus its own small index: distinct as BigInt, a single value as a Number.
// Installed before anything loads fs, so graceful-fs and the ESM bindings of node:fs see it too. Only
// the synchronous stats are emulated, because every log identity read is synchronous.
const fs = require('node:fs');
const HIGH_FILE_ID = 2n ** 70n;
const fileIndexes = new Map();
for (const name of ['statSync', 'fstatSync', 'lstatSync']) {
	const original = fs[name];
	fs[name] = (...args) => {
		const stats = original(...args);
		if (stats?.ino) {
			const realId = BigInt(stats.ino);
			if (!fileIndexes.has(realId)) fileIndexes.set(realId, BigInt(fileIndexes.size + 1));
			const ino = HIGH_FILE_ID + fileIndexes.get(realId);
			stats.ino = typeof stats.ino === 'bigint' ? ino : Number(ino);
		}
		return stats;
	};
}
require('node:module').syncBuiltinESMExports();

const assert = require('node:assert');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const sinon = require('sinon');
const { pinLogConfig } = require('../../../logConfigFixture.js');
const { waitFor } = require('../../../waitFor.js');

const hdbLogger = require('#src/utility/logging/harper_logger');
const { requestStaleDescriptorRelease } = require('#src/utility/logging/logGenerationCoordinator');
// Before the log config is pinned: its environmentManager validates the inherited ROOTPATH's full config.
const { logRotator } = require('#src/utility/logging/logRotator');

const NEVER_TICKS = 3600000;
const root = process.argv[2];
const restoreLogConfig = pinLogConfig({ level: 'error' });

function newLogger(name, rotation) {
	const logPath = path.join(root, name, 'hdb.log');
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	const logger = hdbLogger.createLogger({ stdStreams: false, path: logPath, level: 'error', rotation });
	return { logger, logPath };
}

function replaceUnderLogger(logPath, archivePath = `${logPath}.archived`) {
	fs.renameSync(logPath, archivePath);
	fs.writeFileSync(logPath, 'replacement generation\n');
	const exact = [archivePath, logPath].map((file) => fs.statSync(file, { bigint: true }).ino);
	const rounded = [archivePath, logPath].map((file) => fs.statSync(file).ino);
	assert.notStrictEqual(exact[0], exact[1], 'the emulated file IDs must stay distinct as BigInt');
	assert.strictEqual(rounded[0], rounded[1], 'the emulated file IDs must collide as Numbers');
	return archivePath;
}

function contains(file, marker) {
	return fs.readFileSync(file, 'utf8').includes(marker);
}

async function assertWrittenToLiveFile(logPath, archivePath, marker) {
	await waitFor(() => contains(logPath, marker) || contains(archivePath, marker), {
		timeout: 10000,
		message: `${marker} was never written`,
	});
	assert.ok(contains(logPath, marker), `${marker} was appended to the archived generation`);
}

async function staleSweepReleasesTheArchivedGeneration() {
	const { logger, logPath } = newLogger('staleSweep');
	logger.error('opens the descriptor');
	const archivePath = replaceUnderLogger(logPath);
	assert.ok((await requestStaleDescriptorRelease()).released);
	logger.error('after the stale sweep');
	await assertWrittenToLiveFile(logPath, archivePath, 'after the stale sweep');
}

async function writePathGuardNoticesTheReplacement() {
	const { logger, logPath } = newLogger('writePath', {
		enabled: true,
		maxSize: '16K',
		auditInterval: NEVER_TICKS,
		path: path.join(root, 'writePath', 'rotated'),
	});
	logger.error('opens the descriptor');
	const archivePath = replaceUnderLogger(logPath);
	// The guard checks after each 1000-byte quantum, and the append that crosses it lands first, so
	// only what is written after the filler has flushed must reach the live file.
	for (let i = 0; i < 40; i++) logger.error(`filler ${i} ${'x'.repeat(60)}`);
	await waitFor(() => contains(logPath, 'filler 39 ') || contains(archivePath, 'filler 39 '), {
		timeout: 10000,
		message: 'the filler was never written',
	});
	logger.error('after the checkpoint');
	await assertWrittenToLiveFile(logPath, archivePath, 'after the checkpoint');
}

async function intervalClockSeesTheReplacement() {
	const intervalMs = 60000;
	const { logger, logPath } = newLogger('intervalClock');
	logger.error('first generation');
	const rotatedDir = path.join(root, 'intervalClock', 'rotated');
	// Only Date is faked: the audit ticks still run on real timers, but time passes only when this
	// scenario advances it, so a late tick can postpone a rotation and never cause one.
	const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
	try {
		const rotator = logRotator({
			logger,
			path: rotatedDir,
			enabled: true,
			auditInterval: 20,
			interval: `${intervalMs / 1000}s`,
		});
		clock.tick(intervalMs / 2);
		logger.closeLogFile();
		replaceUnderLogger(logPath, path.join(rotatedDir, 'replaced-by-writer.log'));
		await sleep(100);
		// Past the first generation's interval and short of the replacement's.
		clock.tick(intervalMs / 2 + 1000);
		await sleep(100);
		rotator.end();
		assert.strictEqual(rotator.getLastRotatedLogPath(), undefined, 'the replacement was rotated as if it were old');
	} finally {
		clock.restore();
	}
}

(async () => {
	await staleSweepReleasesTheArchivedGeneration();
	await writePathGuardNoticesTheReplacement();
	await intervalClockSeesTheReplacement();
})().then(
	() => {
		restoreLogConfig();
		process.exit(0);
	},
	(error) => {
		restoreLogConfig();
		process.stderr.write(`${error.stack}\n`);
		process.exit(1);
	}
);
