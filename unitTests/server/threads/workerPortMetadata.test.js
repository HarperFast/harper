'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { THREAD_TYPES } = require('#src/utility/hdbTerms');
const { startWorker } = require('#js/server/threads/manageThreads');

const FIXTURE = path.join(__dirname, 'portMetadata-fixture.cjs');

function startTopologyWorker(name, workerIndex, startedWorkers) {
	return new Promise((resolve, reject) => {
		startWorker(FIXTURE, {
			name,
			workerIndex,
			threadCount: 2,
			autoRestart: false,
			onStarted(worker) {
				startedWorkers.push(worker);
				worker.once('message', resolve);
				worker.once('error', reject);
				worker.once('exit', (code) => reject(new Error(`Worker exited before reporting (code ${code})`)));
			},
		});
	});
}

describe('worker port metadata', function () {
	it('preserves the job-worker flag when an existing port is inherited by a new worker', async function () {
		this.timeout(30000);
		const startedWorkers = [];
		try {
			await startTopologyWorker(THREAD_TYPES.JOB, 0, startedWorkers);
			const jobWorker = startedWorkers[0];
			const observerReport = await startTopologyWorker(THREAD_TYPES.HTTP, 1, startedWorkers);

			assert.deepEqual(
				observerReport.ports.find((port) => port.threadId === jobWorker.threadId),
				{ threadId: jobWorker.threadId, isJobWorker: true }
			);
			assert.equal(observerReport.eligibleThreadIds.includes(jobWorker.threadId), false);
			assert.equal(observerReport.eligibleThreadIds.includes(0), true);
		} finally {
			for (const worker of startedWorkers.reverse()) {
				worker.wasShutdown = true;
				await worker.terminate();
			}
		}
	});
});
