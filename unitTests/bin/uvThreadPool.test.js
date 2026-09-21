'use strict';

// libuv's thread pool is process-global, sized once from UV_THREADPOOL_SIZE on first use, and
// defaults to 4 — a hard ceiling on concurrent native async work (HNSW plane searches, async fs,
// dns) no matter how many threads Harper runs. bin/uvThreadPool.ts raises it at startup.
//
// The sizing only works if it runs before anything submits pool work, and that ordering is not
// self-evident from bin/harper.ts: under ESM (the --conditions=typestrip dev/test path) a module's
// imports are evaluated before its own body, so an assignment written inline at the top of
// bin/harper.ts would have run *after* the logger and every other import. That is why the
// assignment lives in a module imported first rather than in the entry point itself, and why the
// first test below guards the import position.

const assert = require('node:assert');
const { execFile } = require('node:child_process');
const { availableParallelism } = require('node:os');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { PACKAGE_ROOT } = require('#src/utility/packageUtils');

const execFileAsync = promisify(execFile);
const HARNESS = require.resolve('./fixtures/uvThreadPoolHarness.cjs');

function runHarness(size) {
	const env = { ...process.env };
	if (size === undefined) delete env.UV_THREADPOOL_SIZE;
	else env.UV_THREADPOOL_SIZE = size;
	return execFileAsync(process.execPath, [HARNESS], { env }).then(({ stdout }) => JSON.parse(stdout));
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
		const expected = Math.min(1024, Math.max(4, availableParallelism()));
		const { size, workers } = await runHarness(undefined);
		assert.equal(size, String(expected));
		if (process.platform === 'linux') assert.equal(workers, expected);
	});

	it('leaves an explicit UV_THREADPOOL_SIZE alone', async function () {
		this.timeout(30000);
		const { size, workers } = await runHarness('3');
		assert.equal(size, '3');
		if (process.platform === 'linux') assert.equal(workers, 3);
	});
});
