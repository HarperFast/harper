'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// Regression test for the race a component-lock reclaim contender could hit: a dead worker's
// process group is force-terminated asynchronously (SIGKILL only queues delivery), so
// `isThreadRunning()` must not report the owner as gone until that termination is confirmed —
// otherwise a replacement preparation can start mutating files while the old writer may still be
// alive. Run out-of-process because it needs its own real `manageThreads` main-thread state
// (process group tracking, worker exit handling) rather than sharing the mocha process's.
describe('process group reclaim ordering', () => {
	it('does not report a dead worker as reclaimable until its process group is confirmed gone', async () => {
		const harness = spawn(process.execPath, [require.resolve('./fixtures/processGroupReclaimHarness.js')], {
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		let output = '';
		harness.stdout.on('data', (chunk) => (output += chunk));
		await once(harness, 'close');

		const line = output.trim().split('\n').find(Boolean);
		assert.ok(line, `harness produced no output: ${JSON.stringify(output)}`);
		const { stillRunning, groupAlive } = JSON.parse(line);
		assert.equal(stillRunning, false);
		assert.equal(groupAlive, false);
	});
});
