'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// Has to outlast the harness's own WAIT_TIMEOUT_MS, or a harness that reports why it failed is
// pre-empted by a mocha timeout that reports nothing.
const HARNESS_TIMEOUT_MS = 60000;

describe('terminal worker shutdown', () => {
	async function runHarness(mode) {
		const args = [require.resolve('./fixtures/terminalShutdownHarness.cjs')];
		if (mode) args.push(mode);
		const harness = spawn(process.execPath, args, {
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		let output = '';
		harness.stdout.on('data', (chunk) => (output += chunk));
		const [code] = await once(harness, 'close');
		assert.equal(code, 0, `harness exited with ${code}: ${output}`);
		return JSON.parse(output.trim().split('\n').at(-1));
	}

	it('prevents a concurrent rolling restart from respawning workers during full shutdown', async function () {
		this.timeout(HARNESS_TIMEOUT_MS);
		const result = await runHarness();
		assert.deepEqual(result, {
			errorCode: 'ERR_HARPER_PROCESS_SHUTTING_DOWN',
			starts: 2,
			workersAfterShutdown: 0,
		});
	});

	it('does not respawn a worker that exits unexpectedly after terminal shutdown begins', async function () {
		this.timeout(HARNESS_TIMEOUT_MS);
		assert.deepEqual(await runHarness('unexpected'), { starts: 1, workersAfterExit: 0 });
	});

	it('does not start a non-overlapping replacement after terminal shutdown begins', async function () {
		this.timeout(HARNESS_TIMEOUT_MS);
		assert.deepEqual(await runHarness('non-overlapping'), { starts: 1, workersAfterShutdown: 0 });
	});

	it('ignores a rolling restart requested after terminal shutdown begins', async function () {
		this.timeout(HARNESS_TIMEOUT_MS);
		assert.deepEqual(await runHarness('late-restart'), {
			restartNumberChanged: false,
			starts: 1,
			startsAfterLateRestart: 1,
			workersAfterLateRestart: 1,
			workersAfterShutdown: 0,
		});
	});

	it('allows worker creation after a scoped shutdown', async function () {
		this.timeout(HARNESS_TIMEOUT_MS);
		assert.deepEqual(await runHarness('scoped'), { workerCreationAllowed: true });
	});
});
