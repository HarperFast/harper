'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { startWorker, setTerminateTimeout } = require('#js/server/threads/manageThreads');
const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');
const { waitFor } = require('../../waitFor');

const FIXTURE = path.join(__dirname, 'fixtures/shutdownDatabaseStatusWorker.cjs');

describe('worker database-close safety status', function () {
	this.timeout(30_000);
	const defaultTerminateTimeout = process.env.DEV_MODE === 'true' || process.env.DEV_MODE === '1' ? 30_000 : 10_000;

	afterEach(function () {
		setTerminateTimeout(defaultTerminateTimeout);
	});

	function startStatusWorker(messages) {
		const worker = startWorker(FIXTURE, {
			autoRestart: false,
			name: 'database-close-status-test',
			workerIndex: 0,
			threadCount: 1,
		});
		worker.on('message', (message) => messages.push(message));
		return worker;
	}

	it('reports process-global handles pending as soon as shutdown begins', async function () {
		const messages = [];
		const worker = startStatusWorker(messages);
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

	for (const extensionOrder of ['before', 'after']) {
		it(`extends the database-close safety timer when a drain is reported ${extensionOrder} shutdown`, async function () {
			setTerminateTimeout(500);
			const messages = [];
			const worker = startStatusWorker(messages);
			const deadlineMs = Date.now() + 5_000;
			try {
				await waitFor(() => messages.some((message) => message.type === 'fixture-ready'));
				if (extensionOrder === 'before') {
					worker.postMessage({ type: 'fixture-extend-shutdown-deadline', deadlineMs });
					await waitFor(() => messages.some((message) => message.type === 'fixture-deadline-extended'));
				}

				worker.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: 0 });
				await waitFor(() => worker.databaseCloseFailed === true);

				if (extensionOrder === 'after') {
					worker.postMessage({ type: 'fixture-extend-shutdown-deadline', deadlineMs });
					await waitFor(() => messages.some((message) => message.type === 'fixture-deadline-extended'));
				}

				await waitFor(() => worker.databaseCloseSafetyTimer?._idleTimeout > 4_000, {
					timeout: 2_000,
					message: `database-close timer did not honor the drain extension; timeout=${worker.databaseCloseSafetyTimer?._idleTimeout}`,
				});
			} finally {
				worker.wasShutdown = true;
				await worker.terminate();
			}
		});
	}
});
