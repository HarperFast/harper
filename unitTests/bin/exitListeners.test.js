'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// The pid-file cleanup used to call process.exit(0) from inside the 'exit' listener, which rewrote
// the code for every exit, so a process asking to fail reported success to its orchestrator. These
// guard the container-visible exit contract that replaced it.
describe('run exit listeners', () => {
	function spawnHarness(mode) {
		return spawn(process.execPath, [require.resolve('./fixtures/exitListenerHarness.cjs'), mode], {
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
});
