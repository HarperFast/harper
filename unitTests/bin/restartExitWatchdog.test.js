'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

describe('restart exit watchdog', () => {
	it('force-terminates a process that remains alive past its restart bound', async function () {
		if (process.platform !== 'linux') this.skip();
		this.timeout(30000);
		const startedAt = Date.now();
		const harness = spawn(process.execPath, [require.resolve('./fixtures/restartExitWatchdogHarness.cjs'), '100'], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let diagnostics = '';
		harness.stderr.on('data', (chunk) => (diagnostics += chunk));
		await once(harness.stdout, 'data');
		const [code, signal] = await once(harness, 'close');
		assert.equal(code, null);
		assert.equal(signal, 'SIGKILL');
		assert.match(diagnostics, /restart exit watchdog force-killing pid \d+ after 1 seconds/);
		assert.ok(Date.now() - startedAt < 15000, 'watchdog exceeded the test bound');
	});

	it('rejects a non-finite timeout without terminating the caller', async () => {
		const { armRestartExitWatchdog } = require('#src/bin/restartExitWatchdog');
		assert.equal(await armRestartExitWatchdog(Number.NaN), false);
	});

	// The readiness token is what stops arming from reporting success in an environment where the
	// script gives up: every one of its give-up paths is a silent `exit 0`, so a watchdog that never
	// emits the token must never be reported armed. These cover both halves of that — the script
	// withholding the token, and the caller treating a token-less child as unarmed.
	it('withholds its readiness token when the shell cannot find sleep', async function () {
		if (process.platform !== 'linux') this.skip();
		this.timeout(30000);
		const { WATCHDOG_SCRIPT, WATCHDOG_READY_TOKEN } = require('#src/bin/restartExitWatchdog');
		const script = spawn('/bin/sh', ['-c', WATCHDOG_SCRIPT, 'watchdog-test', String(process.pid), '1'], {
			env: { PATH: '/nonexistent-harper-watchdog-path' },
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		let output = '';
		script.stdout.on('data', (chunk) => (output += chunk));
		const [code] = await once(script, 'close');
		assert.equal(code, 0);
		assert.ok(!output.includes(WATCHDOG_READY_TOKEN), `watchdog reported ready without sleep: ${output}`);
	});

	describe('readiness handshake', () => {
		const { WATCHDOG_READY_TOKEN, waitForWatchdogReady } = require('#src/bin/restartExitWatchdog');
		const shell = (script) => spawn('/bin/sh', ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'] });

		beforeEach(function () {
			if (process.platform !== 'linux') this.skip();
		});

		it('reports ready once the token arrives', async () => {
			const child = shell(`echo ${WATCHDOG_READY_TOKEN}; sleep 30`);
			assert.equal(await waitForWatchdogReady(child, 10000), true);
			child.kill('SIGKILL');
		});

		it('reports not ready when the child gives up before the token', async () => {
			assert.equal(await waitForWatchdogReady(shell('exit 0'), 10000), false);
		});

		it('reports not ready when the child neither emits the token nor exits', async () => {
			const child = shell('sleep 30');
			assert.equal(await waitForWatchdogReady(child, 200), false);
			child.kill('SIGKILL');
		});
	});
});
