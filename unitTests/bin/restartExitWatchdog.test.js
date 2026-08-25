'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

describe('restart exit watchdog', () => {
	it('force-terminates a process that remains alive past its restart bound', async function () {
		if (process.platform === 'win32') this.skip();
		this.timeout(10000);
		const startedAt = Date.now();
		const harness = spawn(process.execPath, [require.resolve('./fixtures/restartExitWatchdogHarness.js'), '100'], {
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		await once(harness.stdout, 'data');
		const [code, signal] = await once(harness, 'close');
		assert.equal(code, null);
		assert.equal(signal, 'SIGKILL');
		assert.ok(Date.now() - startedAt < 5000, 'watchdog exceeded the test bound');
	});
});
