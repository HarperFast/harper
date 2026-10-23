'use strict';

const assert = require('node:assert');
const { join } = require('node:path');
const { Worker } = require('node:worker_threads');

function runReplicatedRestart(workerData) {
	return new Promise((resolve, reject) => {
		const worker = new Worker(join(__dirname, 'fixtures', 'replicatedRestartHarness.cjs'), { workerData });
		worker.on('message', (message) => {
			if (message.type === 'restart') worker.postMessage({ type: 'restart-complete' });
			else {
				resolve(message);
				worker.terminate();
			}
		});
		worker.on('error', reject);
	});
}

const BACK_PRESSURE = 'ServerError: Outstanding write transactions have too long a queue, please try again later';

describe('a replicated restart_service job', function () {
	this.timeout(30000);

	it('fails naming the peer it could not restart, keeping every peer outcome', async () => {
		const outcome = await runReplicatedRestart({ dispatchFailures: { 'peer-b': ['Error: Connection closed 1006'] } });
		assert.strictEqual(outcome.completed, undefined, 'a restart that missed a peer must not complete');
		assert.match(outcome.failed.message, /peer-b \(Error: Connection closed 1006\)/);
		assert.deepStrictEqual(outcome.failed.result.replicated, [
			{ node: 'peer-a', message: 'restarted peer-a' },
			{ node: 'peer-b', error: 'Error: Connection closed 1006' },
		]);
	});

	it('completes once a peer that refused for back-pressure restarts on retry', async () => {
		const outcome = await runReplicatedRestart({ dispatchFailures: { 'peer-a': [BACK_PRESSURE] } });
		assert.deepStrictEqual(outcome.completed, {
			replicated: [
				{ node: 'peer-b', message: 'restarted peer-b' },
				{ node: 'peer-a', message: 'restarted peer-a' },
			],
		});
	});

	it('keeps polling, with no unhandled rejection, when a restarting peer drops the connection', async () => {
		const outcome = await runReplicatedRestart({
			pollFailures: { 'peer-a': ['Error: Connection closed 1006'] },
		});
		assert.deepStrictEqual(outcome.unhandled, []);
		assert.strictEqual(outcome.completed.replicated.length, 2);
	});
});
