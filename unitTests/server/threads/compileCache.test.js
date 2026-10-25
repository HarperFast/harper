'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pruneStaleCompileCaches } = require('#src/server/threads/compileCache');

const HARNESS = path.join(__dirname, 'compileCache-fixtures', 'harness.cjs');
const HARNESS_TIMEOUT_MS = 30000;
const CURRENT = `${process.version}-${process.arch}`;
const OTHER_ARCH = process.arch === 'x64' ? 'arm64' : 'x64';

async function runHarness(rootPath, scenario, env = {}) {
	const childEnv = { ...process.env, ...env };
	for (const name of ['NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE']) if (!(name in env)) delete childEnv[name];
	const harness = spawn(process.execPath, [HARNESS, rootPath, scenario], {
		env: childEnv,
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	const deadline = setTimeout(() => harness.kill('SIGKILL'), HARNESS_TIMEOUT_MS);
	try {
		let output = '';
		harness.stdout.on('data', (chunk) => (output += chunk));
		const [code, signal] = await once(harness, 'close');
		assert.equal(code, 0, `harness exited with ${code ?? signal}: ${output}`);
		return JSON.parse(output.trim().split('\n').at(-1));
	} finally {
		clearTimeout(deadline);
		if (harness.exitCode === null && harness.signalCode === null) harness.kill('SIGKILL');
	}
}

describe('compile cache', function () {
	this.timeout(60000);
	let scratch;
	beforeEach(() => {
		scratch = mkdtempSync(path.join(tmpdir(), 'harper-compile-cache-'));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	describe('pruneStaleCompileCaches', () => {
		it('removes only Node-named subdirectories for another Node version or architecture', async () => {
			const cache = path.join(scratch, 'compile');
			const removed = [
				`v1.2.3-x64-0123abcd-1000`,
				`${process.version}-${OTHER_ARCH}-0123abcd-1000`,
				`v1.2.3-arm64-0123abcd`,
			];
			const kept = [
				`${CURRENT}-deadbeef-1000`, // this version under a different V8 tag, as threads.v8Flags gives workers
				`${CURRENT}-0123abcd-2000`,
				'v1.2.3-x64-abc-1000',
				'v1.2.3-x64-0123abcd0-1000',
				'v1.2.3-x64-0123ABCD-1000',
				'v1.2.3-sparc-0123abcd-1000',
				'v1.2.3-rc.1-x64-0123abcd-1000',
				'notes',
			];
			for (const name of [...removed, ...kept]) {
				mkdirSync(path.join(cache, name), { recursive: true });
				writeFileSync(path.join(cache, name, 'entry'), 'x');
			}
			writeFileSync(path.join(cache, 'v9.9.9-x64-0123abcd-1000'), 'a file, not a cache directory');
			const outside = path.join(scratch, 'outside');
			mkdirSync(outside);
			writeFileSync(path.join(outside, 'precious'), 'x');
			if (process.platform !== 'win32') symlinkSync(outside, path.join(cache, 'v8.8.8-x64-0123abcd-1000'));

			await pruneStaleCompileCaches(cache);

			for (const name of removed) assert.ok(!existsSync(path.join(cache, name)), `${name} should be removed`);
			for (const name of kept) assert.ok(existsSync(path.join(cache, name, 'entry')), `${name} should be kept`);
			assert.ok(existsSync(path.join(cache, 'v9.9.9-x64-0123abcd-1000')));
			assert.ok(existsSync(path.join(outside, 'precious')));
			if (process.platform !== 'win32') assert.ok(existsSync(path.join(cache, 'v8.8.8-x64-0123abcd-1000')));
		});

		it('resolves when the directory is missing or cannot be listed', async () => {
			await pruneStaleCompileCaches(path.join(scratch, 'missing'));
			const notADirectory = path.join(scratch, 'file');
			writeFileSync(notADirectory, 'x');
			await pruneStaleCompileCaches(notADirectory);
		});
	});

	describe('enableCompileCache', () => {
		before(function () {
			if (typeof globalThis.Bun !== 'undefined') this.skip();
		});

		it('enables <rootPath>/cache/compile for the main thread and every worker, and prunes stale caches', async () => {
			const rootPath = path.join(scratch, 'root');
			const cache = path.join(rootPath, 'cache', 'compile');
			const stale = path.join(cache, 'v1.2.3-x64-0123abcd-1000');
			mkdirSync(stale, { recursive: true });
			const callerDirectory = path.join(scratch, 'caller-cache');
			const report = await runHarness(rootPath, 'default', {
				COMPILE_CACHE_TEST_STALE: stale,
				COMPILE_CACHE_TEST_CALLER_DIRECTORY: callerDirectory,
			});
			assert.ok(report.mainDirectory.startsWith(path.join(cache, `${CURRENT}-`)), report.mainDirectory);
			// the main thread's env stays unset, so processes it spawns do not inherit the directory
			assert.strictEqual(report.mainEnvDirectory, undefined);
			assert.strictEqual(report.staleCacheRemains, false);
			assert.strictEqual(report.worker.envDirectory, cache);
			assert.ok(report.worker.cacheDirectory.startsWith(path.join(cache, `${CURRENT}-`)));
			// a job worker passes its own env: it keeps its own variables and gains the cache directory
			assert.strictEqual(report.job.jobMark, 'job-1');
			assert.strictEqual(report.job.envDirectory, cache);
			assert.ok(report.job.cacheDirectory.startsWith(path.join(cache, `${CURRENT}-`)));
			// a caller's own NODE_COMPILE_CACHE wins
			assert.strictEqual(report.callerJob.envDirectory, callerDirectory);
			assert.ok(report.callerJob.cacheDirectory.startsWith(callerDirectory));
		});

		it('is a no-op when called again', async () => {
			const rootPath = path.join(scratch, 'root');
			const report = await runHarness(rootPath, 'repeat');
			assert.ok(report.mainDirectory.startsWith(path.join(rootPath, 'cache', 'compile')));
			assert.strictEqual(report.worker.envDirectory, path.join(rootPath, 'cache', 'compile'));
		});

		it('does nothing when NODE_DISABLE_COMPILE_CACHE is set', async () => {
			const rootPath = path.join(scratch, 'root');
			const report = await runHarness(rootPath, 'default', { NODE_DISABLE_COMPILE_CACHE: '1' });
			assert.strictEqual(report.mainDirectory, undefined);
			assert.strictEqual(report.worker.cacheDirectory, undefined);
			assert.strictEqual(report.job.cacheDirectory, undefined);
			assert.ok(!existsSync(path.join(rootPath, 'cache')));
		});

		it("leaves an operator's NODE_COMPILE_CACHE in charge, and never prunes it", async () => {
			const rootPath = path.join(scratch, 'root');
			const operatorDirectory = path.join(scratch, 'operator');
			const operatorStale = path.join(operatorDirectory, 'v1.2.3-x64-0123abcd-1000');
			mkdirSync(operatorStale, { recursive: true });
			const report = await runHarness(rootPath, 'default', { NODE_COMPILE_CACHE: operatorDirectory });
			assert.ok(report.mainDirectory.startsWith(operatorDirectory));
			assert.ok(report.worker.cacheDirectory.startsWith(operatorDirectory));
			assert.ok(report.job.cacheDirectory.startsWith(operatorDirectory));
			assert.ok(existsSync(operatorStale));
			assert.ok(!existsSync(path.join(rootPath, 'cache')));
		});

		it("does not fall back to rootPath when the operator's NODE_COMPILE_CACHE cannot be used", async () => {
			const rootPath = path.join(scratch, 'root');
			const notADirectory = path.join(scratch, 'file');
			writeFileSync(notADirectory, 'x');
			const report = await runHarness(rootPath, 'default', { NODE_COMPILE_CACHE: path.join(notADirectory, 'cache') });
			assert.strictEqual(report.mainDirectory, undefined);
			assert.strictEqual(report.worker.cacheDirectory, undefined);
			assert.ok(!existsSync(path.join(rootPath, 'cache')));
		});

		it('keeps serving uncached when the cache directory cannot be created', async () => {
			const rootPath = path.join(scratch, 'root');
			mkdirSync(rootPath);
			writeFileSync(path.join(rootPath, 'cache'), 'not a directory');
			const report = await runHarness(rootPath, 'default');
			assert.strictEqual(report.mainDirectory, undefined);
			assert.strictEqual(report.worker.envDirectory, undefined);
			assert.strictEqual(report.worker.cacheDirectory, undefined);
		});

		it('does nothing on a runtime without module.enableCompileCache', async () => {
			const rootPath = path.join(scratch, 'root');
			const report = await runHarness(rootPath, 'unsupported');
			assert.strictEqual(report.mainDirectory, undefined);
			assert.strictEqual(report.worker.envDirectory, undefined);
			assert.ok(!existsSync(path.join(rootPath, 'cache')));
		});

		it('does nothing until a server start calls it', async () => {
			const rootPath = path.join(scratch, 'root');
			const report = await runHarness(rootPath, 'import-only');
			assert.strictEqual(report.mainDirectory, undefined);
			assert.strictEqual(report.worker.cacheDirectory, undefined);
			assert.ok(!existsSync(path.join(rootPath, 'cache')));
		});
	});
});
