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

		function stagedPath() {
			// per-process, so a second Harper cannot clear this one's in-flight commit
			return path.join(testRoot, hdbTerms.BACKUP_DIR_NAME, `.harper-config-state.pending.${process.pid}.json`);
		}

		it('stages beside the confirmed state and only promotes it once the config file is written', function () {
			process.env.HARPER_SET_CONFIG = '{"http":{"port":8123}}';
			const { config, saveState, confirmConfigWritten } = prepareRuntimeEnvConfig({ http: { port: 9926 } }, testRoot);

			assert.strictEqual(config.http.port, 8123, 'env layer applied in memory');
			assert.strictEqual(fs.existsSync(statePath()), false);
			assert.strictEqual(fs.existsSync(stagedPath()), false);

			assert.strictEqual(saveState(), true);
			assert.strictEqual(fs.existsSync(stagedPath()), true, 'staged copy written');
			assert.strictEqual(fs.existsSync(statePath()), false, 'confirmed record waits for the config file');

			assert.strictEqual(confirmConfigWritten(), true);
			assert.strictEqual(fs.existsSync(statePath()), true);
			assert.strictEqual(fs.existsSync(stagedPath()), false, 'promotion is a rename, not a copy');
		});

		it('leaves the confirmed state untouched when the config write never lands', function () {
			// The record of the operator's pre-env values lives only here. A staged copy that was
			// never promoted must not cost them that.
			process.env.HARPER_SET_CONFIG = '{"http":{"port":8123}}';
			const first = prepareRuntimeEnvConfig({ http: { port: 9926 } }, testRoot);
			first.saveState();
			first.confirmConfigWritten();
			const confirmed = fs.readFileSync(statePath(), 'utf8');
			assert.deepStrictEqual(JSON.parse(confirmed).originalValues, { 'http.port': 9926 });

			process.env.HARPER_SET_CONFIG = '{"http":{"port":8124}}';
			const second = prepareRuntimeEnvConfig({ http: { port: 8123 } }, testRoot);
			assert.strictEqual(second.saveState(), true);
			discardConfigState(testRoot);

			assert.strictEqual(fs.existsSync(stagedPath()), false);
			assert.strictEqual(fs.readFileSync(statePath(), 'utf8'), confirmed, 'confirmed record survives verbatim');
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

		it('clears a staged copy left by an interrupted commit, keeping the confirmed originals', function () {
			// The crash window: staged, config file possibly written, process died before the rename.
			// This boot cannot tell that from a manual user edit, so it must not guess - and must not
			// lose the confirmed originals while deciding.
			process.env.HARPER_SET_CONFIG = '{"http":{"port":8123}}';
			const first = prepareRuntimeEnvConfig({ http: { port: 9926 } }, testRoot);
			first.saveState();
			first.confirmConfigWritten();

			process.env.HARPER_SET_CONFIG = '{"http":{"port":8124}}';
			prepareRuntimeEnvConfig({ http: { port: 8123 } }, testRoot).saveState();
			assert.strictEqual(fs.existsSync(stagedPath()), true, 'a commit is in flight');

			// Next boot
			prepareRuntimeEnvConfig({ http: { port: 8123 } }, testRoot);
			assert.strictEqual(fs.existsSync(stagedPath()), false, 'the interrupted commit is cleared');
			assert.deepStrictEqual(
				JSON.parse(fs.readFileSync(statePath(), 'utf8')).originalValues,
				{ 'http.port': 9926 },
				"the operator's pre-env value is still recorded"
			);
		});

		it("leaves another live process's staged commit alone", function () {
			// One shared name would let a starting server clear a running CLI's in-flight commit, and
			// the loser would rewrite the config file with the confirmed state still describing the old
			// values - the exact state this protocol exists to prevent.
			process.env.HARPER_SET_CONFIG = '{"http":{"port":8123}}';
			const backupDir = path.join(testRoot, hdbTerms.BACKUP_DIR_NAME);
			fs.ensureDirSync(backupDir);
			const liveOwner = path.join(backupDir, `.harper-config-state.pending.${process.ppid}.json`);
			// A pid that was real and is now gone, rather than one hardcoded and hoped to be free
			const { execFileSync } = require('node:child_process');
			const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']));
			const deadOwner = path.join(backupDir, `.harper-config-state.pending.${deadPid}.json`);
			fs.writeFileSync(liveOwner, '{}');
			fs.writeFileSync(deadOwner, '{}');

			prepareRuntimeEnvConfig({ http: { port: 9926 } }, testRoot);

			assert.strictEqual(fs.existsSync(liveOwner), true, "a live owner's commit is untouched");
			assert.strictEqual(fs.existsSync(deadOwner), false, "a dead owner's commit is cleared");
		});

		it('tolerates discarding when nothing is staged', function () {
			discardConfigState(testRoot);
			assert.strictEqual(fs.existsSync(stagedPath()), false);
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
		// The recursion this guards against runs through console: installStdioGuard routes console
		// output back into the file logger. Make any console use fatal, so a fallback that reaches
		// for it fails the test outright rather than depending on the guard being wired here.
		console.log = console.error = () => { throw new Error('fallback used console'); };
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
		});

		assert.match(output, /CHILD-SURVIVED/, 'the process survived a refused log append');
		assert.match(output, /line 0 cannot be written/, 'the entry reached stdout rather than being dropped');
		assert.doesNotMatch(output, /Maximum call stack/, 'the fallback did not re-enter the file logger');
	});
});

// Only the main thread persists config: every worker derives the same merged config, and letting
// them all write it is what put four threads on one pair of files (#847). A real worker, because
// the guard reads worker_threads.isMainThread and nothing else can tell the truth about that.
describe('config persistence from a worker thread (#847)', function () {
	it('applies the env layer in memory without touching the files', function (done) {
		const { Worker } = require('node:worker_threads');
		const os = require('node:os');
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-847-worker-'));
		const configPath = path.join(root, hdbTerms.HARPER_CONFIG_FILE);
		const { execFileSync } = require('node:child_process');
		// A real config file, built the way an install builds one, plus the directories it validates
		const fixtureEnv = { ...process.env };
		// The fixture must not inherit a config env var from a sibling suite: install would then
		// write the very state file this test asserts a worker does not create.
		for (const name of ['HARPER_CONFIG', 'HARPER_DEFAULT_CONFIG', 'HARPER_SET_CONFIG']) delete fixtureEnv[name];
		execFileSync(
			process.execPath,
			[
				'-e',
				`require(${JSON.stringify(require.resolve('#src/config/configUtils'))}).createConfigFile({ ROOTPATH: ${JSON.stringify(root)}, LOGGING_LEVEL: 'error' })`,
			],
			{ env: fixtureEnv }
		);
		for (const dir of ['database', 'log', 'components', hdbTerms.BACKUP_DIR_NAME])
			fs.ensureDirSync(path.join(root, dir));
		const before = fs.readFileSync(configPath, 'utf8');

		const worker = new Worker(
			`
			const configUtils = require(${JSON.stringify(require.resolve('#src/config/configUtils'))});
			const { parentPort } = require('node:worker_threads');
			try {
				configUtils.initConfig(true);
				parentPort.postMessage({ port: configUtils.getConfigValue('http_port') });
			} catch (error) {
				parentPort.postMessage({ error: error.message });
			}
		`,
			{ eval: true, env: { ...fixtureEnv, ROOTPATH: root, HARPER_SET_CONFIG: '{"http":{"port":8123}}' } }
		);

		worker.on('message', (result) => {
			try {
				assert.strictEqual(result.error, undefined, `worker failed: ${result.error}`);
				assert.strictEqual(result.port, 8123, 'the worker still runs on the merged config');
				assert.strictEqual(fs.readFileSync(configPath, 'utf8'), before, 'no config write from a worker');
				assert.strictEqual(
					fs.existsSync(path.join(root, hdbTerms.BACKUP_DIR_NAME, '.harper-config-state.json')),
					false,
					'no env-config state write from a worker'
				);
				done();
			} catch (error) {
				done(error);
			} finally {
				worker.terminate();
				fs.removeSync(root);
			}
		});
	});
});
