'use strict';

const assert = require('node:assert');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');

const { atomicWriteFile, isStorageExhausted, persistConfigDuringBoot } = require('#src/config/configUtils');
const { prepareRuntimeEnvConfig, discardConfigState } = require('#src/config/harperConfigEnvVars');
const hdbTerms = require('#src/utility/hdbTerms');

// A real ENOSPC/EDQUOT needs a volume with no room, which no unit test can arrange portably.
function storageExhaustedError(errnoName) {
	const errno = os.constants.errno[errnoName];
	// Node has no code mapping for EDQUOT on Linux: the error arrives as `Unknown system error
	// -122` and only the errno identifies it.
	return Object.assign(new Error(`Unknown system error -${errno}`), {
		errno: -errno,
		code: `Unknown system error -${errno}`,
		syscall: 'open',
	});
}

describe('storage exhaustion during boot (#847)', function () {
	let testRoot;
	const savedEnv = {};

	beforeEach(function () {
		testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-847-'));
		for (const name of ['HARPER_CONFIG', 'HARPER_DEFAULT_CONFIG', 'HARPER_SET_CONFIG']) {
			savedEnv[name] = process.env[name];
			delete process.env[name];
		}
	});

	afterEach(function () {
		for (const [name, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		fs.removeSync(testRoot);
	});

	describe('isStorageExhausted', function () {
		it('recognizes EDQUOT by errno when the platform gives no usable code', function () {
			assert.strictEqual(isStorageExhausted(storageExhaustedError('EDQUOT')), true);
		});

		it('recognizes ENOSPC by errno and by code', function () {
			assert.strictEqual(isStorageExhausted(storageExhaustedError('ENOSPC')), true);
			assert.strictEqual(isStorageExhausted(Object.assign(new Error('full'), { code: 'ENOSPC' })), true);
		});

		it('does not claim unrelated write failures', function () {
			assert.strictEqual(isStorageExhausted(Object.assign(new Error('denied'), { code: 'EACCES' })), false);
			assert.strictEqual(isStorageExhausted(Object.assign(new Error('gone'), { code: 'ENOENT', errno: -2 })), false);
			assert.strictEqual(isStorageExhausted(undefined), false);
		});
	});

	describe('persistConfigDuringBoot', function () {
		it('reports a completed write', function () {
			assert.strictEqual(
				persistConfigDuringBoot('artifact', () => {}),
				true
			);
		});

		it('swallows storage exhaustion so startup continues', function () {
			assert.strictEqual(
				persistConfigDuringBoot('artifact', () => {
					throw storageExhaustedError('EDQUOT');
				}),
				false
			);
		});

		it('rethrows anything that is not storage exhaustion', function () {
			assert.throws(
				() =>
					persistConfigDuringBoot('artifact', () => {
						throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
					}),
				/permission denied/
			);
		});
	});

	describe('atomicWriteFile', function () {
		it('skips a byte-identical write when asked, leaving the file untouched', function () {
			const target = path.join(testRoot, 'config.yaml');
			fs.writeFileSync(target, 'rootPath: /hdb\n');
			const mtimeBefore = fs.statSync(target).mtimeMs;

			assert.strictEqual(atomicWriteFile(target, 'rootPath: /hdb\n', { skipIfUnchanged: true }), false);
			assert.strictEqual(fs.statSync(target).mtimeMs, mtimeBefore);
		});

		it('writes when the content differs or the file is absent, even with skipIfUnchanged', function () {
			const target = path.join(testRoot, 'config.yaml');
			assert.strictEqual(atomicWriteFile(target, 'rootPath: /a\n', { skipIfUnchanged: true }), true);
			assert.strictEqual(atomicWriteFile(target, 'rootPath: /b\n', { skipIfUnchanged: true }), true);
			assert.strictEqual(fs.readFileSync(target, 'utf8'), 'rootPath: /b\n');
		});

		it('rewrites identical content by default', function () {
			const target = path.join(testRoot, 'config.yaml');
			fs.writeFileSync(target, 'rootPath: /hdb\n');
			assert.strictEqual(atomicWriteFile(target, 'rootPath: /hdb\n'), true);
		});

		it('leaves no temp file behind when the write itself fails', function () {
			// One orphaned temp file per boot is not survivable on a volume that is already full.
			const target = path.join(testRoot, 'missing-dir', 'config.yaml');
			assert.throws(() => atomicWriteFile(target, 'rootPath: /hdb\n'), /ENOENT/);
			assert.deepStrictEqual(fs.readdirSync(testRoot), []);
		});
	});

	describe('env config state ordering', function () {
		function statePath() {
			return path.join(testRoot, hdbTerms.BACKUP_DIR_NAME, '.harper-config-state.json');
		}

		it('does not touch the state file until the caller commits it', function () {
			process.env.HARPER_SET_CONFIG = '{"http":{"port":8123}}';
			const { config, saveState } = prepareRuntimeEnvConfig({ http: { port: 9926 } }, testRoot);

			assert.strictEqual(config.http.port, 8123, 'env layer applied in memory');
			assert.strictEqual(fs.existsSync(statePath()), false, 'state must wait for the config file write');

			saveState();
			assert.strictEqual(fs.existsSync(statePath()), true);
		});

		it('reports whether the snapshot write actually rewrote the file', function () {
			// The rollback keys off this: an unchanged snapshot still describes the file on disk, so
			// it must not be discarded when only the config write is refused.
			process.env.HARPER_SET_CONFIG = '{"http":{"port":8123}}';
			const first = prepareRuntimeEnvConfig({ http: { port: 9926 } }, testRoot);
			assert.strictEqual(first.saveState(), true);
			assert.strictEqual(first.confirmConfigWritten(), true);

			const second = prepareRuntimeEnvConfig({ http: { port: 8123 } }, testRoot);
			assert.strictEqual(second.saveState(), false, 'a boot that re-derives the same state writes nothing');
		});

		it('discards a snapshot whose config-file write never completed', function () {
			// The crash window: the snapshot rename landed, the process died before the config
			// rename. The mark is the only thing that distinguishes this from a manual user edit.
			process.env.HARPER_SET_CONFIG = '{"http":{"port":8123}}';
			prepareRuntimeEnvConfig({ http: { port: 9926 } }, testRoot).saveState();
			assert.strictEqual(JSON.parse(fs.readFileSync(statePath(), 'utf8')).pendingConfigWrite, true);

			// Next boot loads it: a pending snapshot must not be trusted as a description of the file.
			prepareRuntimeEnvConfig({ http: { port: 9926 } }, testRoot).confirmConfigWritten();
			const reloaded = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
			assert.strictEqual(reloaded.pendingConfigWrite, undefined);
			assert.deepStrictEqual(reloaded.originalValues, { 'http.port': 9926 }, 'originals re-derived from the file');
		});

		it('discards a snapshot that would misdescribe the config file', function () {
			process.env.HARPER_SET_CONFIG = '{"http":{"port":8123}}';
			prepareRuntimeEnvConfig({ http: { port: 9926 } }, testRoot).saveState();
			assert.strictEqual(fs.existsSync(statePath()), true);

			discardConfigState(testRoot);
			assert.strictEqual(fs.existsSync(statePath()), false);
		});

		it('tolerates discarding when there is no state file', function () {
			discardConfigState(testRoot);
			assert.strictEqual(fs.existsSync(statePath()), false);
		});
	});
});

// The logger's fallback is the other half of #847: an append that cannot land must not throw, and
// must not reach the console, because installStdioGuard routes console output back into this same
// file logger and the recursion ends in a stack overflow. /dev/full refuses every write for real,
// so this needs no stubbing - it just needs a platform that has it.
describe('log writes that cannot land (#847)', function () {
	const childScript = `
		const { createLogger, initLogSettings } = require(${JSON.stringify(require.resolve('#src/utility/logging/harper_logger'))});
		initLogSettings(true);
		const logger = createLogger({ path: '/dev/full', level: 'error' });
		for (let i = 0; i < 3; i++) logger.error('line ' + i + ' cannot be written');
		process.stdout.write('CHILD-SURVIVED\\n');
	`;

	it('falls back to stdio instead of throwing or recursing', function () {
		if (!fs.existsSync('/dev/full')) return this.skip();
		const { execFileSync } = require('node:child_process');

		const output = execFileSync(process.execPath, ['-e', childScript], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, HARPER_ROOT: testRoot },
		});

		assert.match(output, /CHILD-SURVIVED/, 'the process survived a refused log append');
		assert.match(output, /line 0 cannot be written/, 'the entry reached stdout rather than being dropped');
		assert.doesNotMatch(output, /Maximum call stack/, 'the fallback did not re-enter the file logger');
	});
});
