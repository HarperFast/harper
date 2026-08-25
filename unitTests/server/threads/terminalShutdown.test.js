'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

describe('terminal worker shutdown', () => {
	it('prevents a cleared worker shutdown flag from creating another worker', async function () {
		this.timeout(30000);
		const harness = spawn(process.execPath, [require.resolve('./fixtures/terminalShutdownHarness.cjs')], {
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		let output = '';
		harness.stdout.on('data', (chunk) => (output += chunk));
		const [code] = await once(harness, 'close');
		assert.equal(code, 0, `harness exited with ${code}: ${output}`);
		const result = JSON.parse(output.trim().split('\n').at(-1));
		assert.deepEqual(result, {
			errorCode: 'ERR_HARPER_PROCESS_SHUTTING_DOWN',
			starts: 1,
			workersAfterShutdown: 0,
		});
	});
});
