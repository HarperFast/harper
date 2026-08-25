'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

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

	it('prevents full shutdown from respawning a worker whose shutdown flag is cleared', async function () {
		this.timeout(30000);
		const result = await runHarness();
		assert.deepEqual(result, {
			errorCode: 'ERR_HARPER_PROCESS_SHUTTING_DOWN',
			starts: 1,
			workersAfterShutdown: 0,
		});
	});

	it('allows worker creation after a scoped shutdown', async function () {
		this.timeout(30000);
		assert.deepEqual(await runHarness('scoped'), { workerCreationAllowed: true });
	});
});
