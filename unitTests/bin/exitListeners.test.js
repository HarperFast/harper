'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// The pid-file cleanup used to call process.exit(0) from inside the 'exit' listener, which rewrote
// the code for every exit, so a process asking to fail reported success to its orchestrator. These
// guard the container-visible exit contract that replaced it.
describe('run exit listeners', () => {
	function spawnHarness(mode, ...args) {
		return spawn(process.execPath, [require.resolve('./fixtures/exitListenerHarness.cjs'), mode, ...args], {
			stdio: ['ignore', 'pipe', 'inherit'],
		});
	}

	it('preserves a requested non-zero exit code', async function () {
		this.timeout(30000);
		const harness = spawnHarness('1');
		const [code] = await once(harness, 'close');
		assert.equal(code, 1);
	});

	it('preserves a zero exit code', async function () {
		this.timeout(30000);
		const harness = spawnHarness('0');
		const [code] = await once(harness, 'close');
		assert.equal(code, 0);
	});

	it('exits zero on SIGTERM', async function () {
		this.timeout(30000);
		const harness = spawnHarness('signal');
		await once(harness.stdout, 'data');
		harness.kill('SIGTERM');
		const [code, signal] = await once(harness, 'close');
		assert.equal(signal, null);
		assert.equal(code, 0);
	});

	it('waits for the shutdown on the first signal and exits zero at once on the second', async function () {
		this.timeout(30000);
		const harness = spawnHarness('stalled-shutdown', '60000');
		await once(harness.stdout, 'data');
		const closed = once(harness, 'close');
		harness.kill('SIGTERM');
		const outcome = await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000, 'running'))]);
		assert.equal(outcome, 'running', 'the first signal must not exit while the shutdown is pending');
		const secondAt = Date.now();
		harness.kill('SIGINT');
		const [code, signal] = await closed;
		assert.equal(signal, null);
		assert.equal(code, 0);
		assert.ok(Date.now() - secondAt < 10000, `exited ${Date.now() - secondAt} ms after the second signal`);
	});

	it('exits zero at threads.shutdownTimeout when the shutdown never finishes', async function () {
		this.timeout(30000);
		const harness = spawnHarness('stalled-shutdown', '500');
		await once(harness.stdout, 'data');
		const signalledAt = Date.now();
		harness.kill('SIGTERM');
		const [code, signal] = await once(harness, 'close');
		const elapsed = Date.now() - signalledAt;
		assert.equal(signal, null);
		assert.equal(code, 0);
		assert.ok(elapsed >= 450 && elapsed < 15000, `exited ${elapsed} ms after the signal`);
	});
});
