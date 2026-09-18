'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { startWorker } = require('#js/server/threads/manageThreads');
const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');
const { waitFor } = require('../../waitFor');

const FIXTURE = path.join(__dirname, 'fixtures/shutdownDatabaseStatusWorker.cjs');

describe('worker database-close safety status', function () {
	this.timeout(30_000);

	it('reports process-global handles pending as soon as shutdown begins', async function () {
		const messages = [];
		const worker = startWorker(FIXTURE, {
			autoRestart: false,
			name: 'database-close-status-test',
			workerIndex: 0,
			threadCount: 1,
		});
		worker.on('message', (message) => messages.push(message));
		try {
			await waitFor(() => messages.some((message) => message.type === 'fixture-ready'));
			worker.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: 0 });
			await waitFor(() => worker.databaseCloseFailed === true, {
				timeout: 5_000,
				message: `shutdown did not report database handles pending; messages=${JSON.stringify(messages)}`,
			});
			assert.strictEqual(worker.databaseCloseFailed, true);
		} finally {
			worker.wasShutdown = true;
			await worker.terminate();
		}
	});
});
