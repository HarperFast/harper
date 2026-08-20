'use strict';

const assert = require('node:assert');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');

const { atomicWriteFile, isStorageExhausted, persistConfigDuringBoot } = require('#src/config/configUtils');
const { prepareRuntimeEnvConfig, discardConfigState } = require('#src/config/harperConfigEnvVars');
const hdbTerms = require('#src/utility/hdbTerms');

// A real ENOSPC/EDQUOT needs a volume with no room, which a unit test cannot arrange portably, so
// the failures below are synthetic errors carrying the errno the platform would report. The
// end-to-end proof that boot survives an exhausted volume is the live run recorded in the PR.
function storageExhaustedError(errnoName) {
	const errno = os.constants.errno[errnoName];
	// Node has no code mapping for EDQUOT on Linux (where this was reported): the error arrives as
	// `Unknown system error -122` and only the errno identifies it.
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
