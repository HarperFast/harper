'use strict';

// libuv's pool is process-global and sized once, from UV_THREADPOOL_SIZE, when the first task is
// submitted — so bin/uvThreadPool.ts only works if nothing submits before it runs. Under ESM a
// module's imports are evaluated before its own body, which is why the assignment is a module
// bin/harper.ts imports first rather than a line at the top of bin/harper.ts.

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
	it('is the first import in bin/harper.ts', () => {
		const source = readFileSync(path.join(PACKAGE_ROOT, 'bin/harper.ts'), 'utf8');
		const firstImport = /^import\s.*$/m.exec(source);
		assert.ok(firstImport, 'bin/harper.ts has no import statements');
		assert.match(
			firstImport[0],
			/'\.\/uvThreadPool\.ts'/,
			"uvThreadPool must stay bin/harper.ts's first import — anything evaluated before it can " +
				"initialize libuv's pool at the default of 4"
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

	// The thread count, not the environment variable, is what distinguishes this from the bug: with
	// the imports in the other order the harness reports size 20 and workers 4.
	it('wins the race against a later import under ESM', async function () {
		this.timeout(30000);
		if (process.platform !== 'linux') this.skip();
		const { workers } = await runHarness('uvThreadPoolEsmHarness.mjs');
		assert.equal(workers, EXPECTED);
	});
});
