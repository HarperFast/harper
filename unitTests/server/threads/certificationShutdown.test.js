'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

describe('a certifying rollout declined at shutdown', function () {
	this.timeout(60000);

	it('closes only once a rejection already under way has been recorded', async () => {
		const harness = spawn(process.execPath, [require.resolve('./fixtures/certificationShutdownHarness.cjs')], {
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		let output = '';
		harness.stdout.on('data', (chunk) => (output += chunk));
		const [code] = await once(harness, 'close');
		assert.equal(code, 0, `harness exited with ${code}: ${output}`);
		const { order } = JSON.parse(output.trim().split('\n').at(-1));
		assert.deepStrictEqual(order, ['decide:rejected', 'decided', 'complete']);
	});
});
