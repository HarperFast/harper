'use strict';

const assert = require('node:assert');
const { Worker } = require('node:worker_threads');

const manageThreadsPath = require.resolve('#js/server/threads/manageThreads');
const LATE_BOUND_FUNCTIONS = ['sendToThread', 'getThreadInfo', 'getRunningIsolatedApplications'];
const REPORT = 'late-export-report';

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
				type: workerData.REPORT,
				types: Object.fromEntries(workerData.names.map((name) => [name, typeof manageThreads[name]])),
				whenThreadsStartedIsPromise: manageThreads.whenThreadsStarted instanceof Promise,
			});`,
			{
				eval: true,
				workerData: { addPorts: [], addThreadIds: [], manageThreadsPath, names: LATE_BOUND_FUNCTIONS, REPORT },
			}
		);
		try {
			// Loading the module in a worker can post its own messages first (os-thread-id on Linux).
			const report = await new Promise((resolve, reject) => {
				worker.on('message', (message) => {
					if (message?.type === REPORT) resolve(message);
				});
				worker.once('error', reject);
				worker.once('exit', (code) => reject(new Error(`worker exited with ${code} before reporting`)));
			});
			assert.deepStrictEqual(report.types, Object.fromEntries(LATE_BOUND_FUNCTIONS.map((name) => [name, 'function'])));
			assert.strictEqual(report.whenThreadsStartedIsPromise, true);
		} finally {
			await worker.terminate();
		}
	});

	it('settle whenThreadsStarted through the exported threadsHaveStarted', async () => {
		// A fresh worker gets its own module instance, so resolving there leaves this process's promise pending.
		const worker = new Worker(
			`const { parentPort, workerData } = require('node:worker_threads');
			const { whenThreadsStarted, threadsHaveStarted } = require(workerData.manageThreadsPath);
			const settledBeforeNextTask = () =>
				Promise.race([whenThreadsStarted.then(() => true), new Promise((resolve) => setImmediate(resolve, false))]);
			(async () => {
				const beforeResolve = await settledBeforeNextTask();
				threadsHaveStarted();
				const afterResolve = await settledBeforeNextTask();
				parentPort.postMessage({ type: workerData.REPORT, beforeResolve, afterResolve });
			})();`,
			{ eval: true, workerData: { addPorts: [], addThreadIds: [], manageThreadsPath, REPORT } }
		);
		try {
			const report = await new Promise((resolve, reject) => {
				worker.on('message', (message) => {
					if (message?.type === REPORT) resolve(message);
				});
				worker.once('error', reject);
				worker.once('exit', (code) => reject(new Error(`worker exited with ${code} before reporting`)));
			});
			assert.strictEqual(report.beforeResolve, false, 'whenThreadsStarted settled before threadsHaveStarted ran');
			assert.strictEqual(report.afterResolve, true, 'threadsHaveStarted did not settle whenThreadsStarted');
		} finally {
			await worker.terminate();
		}
	});
});
