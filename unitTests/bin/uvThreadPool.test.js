'use strict';

// libuv's pool is sized once, when the first task is submitted, so bin/uvThreadPool.ts only works
// if nothing submits before it runs. These assert the worker count, not the environment variable:
// only the count distinguishes a pool that sized from one that read the value too late.

const assert = require('node:assert');
const { execFile } = require('node:child_process');
const { availableParallelism } = require('node:os');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { PACKAGE_ROOT } = require('#src/utility/packageUtils');

const execFileAsync = promisify(execFile);
const EXPECTED = Math.min(1024, Math.max(4, availableParallelism()));

function runHarness(harness, size) {
	const env = { ...process.env };
	if (size === undefined) delete env.UV_THREADPOOL_SIZE;
	else env.UV_THREADPOOL_SIZE = size;
	return execFileAsync(process.execPath, [require.resolve(`./fixtures/${harness}`)], { env }).then(({ stdout }) =>
		JSON.parse(stdout)
	);
}

describe('libuv thread pool sizing', () => {
	it('is the first import in bin/harper.ts after the native-addon guard', () => {
		const source = readFileSync(path.join(PACKAGE_ROOT, 'bin/harper.ts'), 'utf8');
		const imports = source.match(/^import\s.*$/gm) ?? [];
		assert.ok(imports.length, 'bin/harper.ts has no import statements');
		// The native-addon guard installs by wrapping process.dlopen and must load before anything
		// that can load a native addon; it does no filesystem/async work itself, so it may precede
		// uvThreadPool without reopening the race this test guards against.
		const [first, ...rest] = imports;
		const poolImport = /nativeAddonGuard\.ts'/.test(first) ? rest[0] : first;
		assert.ok(poolImport, 'bin/harper.ts has no import after the native-addon guard');
		assert.match(
			poolImport,
			/'\.\/uvThreadPool\.ts'/,
			"uvThreadPool must stay bin/harper.ts's first import after the native-addon guard (if " +
				"present) — anything else evaluated before it can initialize libuv's pool at the default of 4"
		);
	});

	it('sizes the pool to the available parallelism', async function () {
		this.timeout(30000);
		const { size, workers } = await runHarness('uvThreadPoolHarness.cjs');
		assert.equal(size, String(EXPECTED));
		if (process.platform === 'linux') assert.equal(workers, EXPECTED);
	});

	it('leaves an explicit UV_THREADPOOL_SIZE alone', async function () {
		this.timeout(30000);
		const { size, workers } = await runHarness('uvThreadPoolHarness.cjs', '3');
		assert.equal(size, '3');
		if (process.platform === 'linux') assert.equal(workers, 3);
	});

	it('wins the race against a later import under ESM', async function () {
		this.timeout(30000);
		if (process.platform !== 'linux') this.skip();
		const { workers } = await runHarness('uvThreadPoolEsmHarness.mjs');
		assert.equal(workers, EXPECTED);
	});
});
