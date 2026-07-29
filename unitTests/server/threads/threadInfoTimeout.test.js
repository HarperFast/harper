'use strict';

const assert = require('node:assert');
const { Worker } = require('node:worker_threads');

const { waitFor } = require('../../waitFor.js');

function startThreadInfoWorker(timeoutMs) {
	const manageThreadsPath = require.resolve('#src/server/threads/manageThreads');
	return new Worker(
		`const { parentPort, workerData } = require('node:worker_threads');
		const { isThreadRunning } = require(workerData.manageThreadsPath);
		const baselineListeners = parentPort.listenerCount('message');
		isThreadRunning(12345, workerData.timeoutMs).then(
			(isRunning) => parentPort.postMessage({
				isRunning,
				listenerCount: parentPort.listenerCount('message'),
				baselineListeners,
			}),
			(error) => parentPort.postMessage({
				code: error.code,
				listenerCount: parentPort.listenerCount('message'),
				baselineListeners,
			})
		);`,
		{
			eval: true,
			workerData: { addPorts: [], addThreadIds: [], manageThreadsPath, timeoutMs },
		}
	);
}

describe('thread information liveness timeout', () => {
	it('rejects and removes its response listener when the main thread does not reply', async () => {
		const worker = startThreadInfoWorker(50);
		const messages = [];
		worker.on('message', (message) => messages.push(message));
		try {
			await waitFor(() => messages.some((message) => message.code || 'isRunning' in message));
			const result = messages.find((message) => message.code || 'isRunning' in message);
			assert.equal(result.code, 'ERR_THREAD_INFO_TIMEOUT');
			assert.equal(result.listenerCount, result.baselineListeners);
		} finally {
			await worker.terminate();
		}
	});

	it('resolves and removes its response listener when the main thread replies', async () => {
		const worker = startThreadInfoWorker(500);
		const messages = [];
		worker.on('message', (message) => {
			messages.push(message);
			if (message.type === 'request_thread_info') {
				worker.postMessage({ type: 'thread_info', workers: [{ threadId: 12345 }] });
			}
		});
		try {
			await waitFor(() => messages.some((message) => 'isRunning' in message));
			const result = messages.find((message) => 'isRunning' in message);
			assert.equal(result.isRunning, true);
			assert.equal(result.listenerCount, result.baselineListeners);
		} finally {
			await worker.terminate();
		}
	});
});
