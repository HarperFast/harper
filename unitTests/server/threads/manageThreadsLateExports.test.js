'use strict';

const assert = require('node:assert');
const { Worker } = require('node:worker_threads');

const manageThreadsPath = require.resolve('#src/server/threads/manageThreads');
const LATE_BOUND_FUNCTIONS = ['sendToThread', 'threadsHaveStarted', 'getThreadInfo', 'getRunningIsolatedApplications'];

describe('manageThreads late-bound exports', () => {
	it('hold their real values on the main thread once the module has loaded', () => {
		const manageThreads = require(manageThreadsPath);
		for (const name of [...LATE_BOUND_FUNCTIONS, 'watchDir']) {
			assert.strictEqual(typeof manageThreads[name], 'function', name);
		}
		assert.ok(manageThreads.whenThreadsStarted instanceof Promise);
	});

	it('hold their real values in a worker once the module has loaded', async () => {
		const worker = new Worker(
			`const { parentPort, workerData } = require('node:worker_threads');
			const manageThreads = require(workerData.manageThreadsPath);
			parentPort.postMessage({
				types: Object.fromEntries(workerData.names.map((name) => [name, typeof manageThreads[name]])),
				whenThreadsStartedIsPromise: manageThreads.whenThreadsStarted instanceof Promise,
			});`,
			{
				eval: true,
				workerData: { addPorts: [], addThreadIds: [], manageThreadsPath, names: LATE_BOUND_FUNCTIONS },
			}
		);
		try {
			const result = await new Promise((resolve, reject) => {
				worker.once('message', resolve);
				worker.once('error', reject);
			});
			assert.deepStrictEqual(result.types, Object.fromEntries(LATE_BOUND_FUNCTIONS.map((name) => [name, 'function'])));
			assert.strictEqual(result.whenThreadsStartedIsPromise, true);
		} finally {
			await worker.terminate();
		}
	});
});
