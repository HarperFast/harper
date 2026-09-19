'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { MessageChannel } = require('node:worker_threads');
const { startWorker, setTerminateTimeout, stopWorker } = require('#js/server/threads/manageThreads');
const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');
const { DATABASE_QUIESCENCE_TIMEOUT_MS } = require('#src/utility/databaseLifecycle');
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
			const shutdownStartedAt = Date.now();
			worker.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: 0 });
			await waitFor(() => worker.databaseClosePending === true, {
				timeout: 5_000,
				message: `shutdown did not report database handles pending; messages=${JSON.stringify(messages)}`,
			});
			assert.strictEqual(worker.databaseClosePending, true);
			assert.ok(
				worker.databaseCloseSafetyDeadline >= shutdownStartedAt + DATABASE_QUIESCENCE_TIMEOUT_MS,
				`database-close deadline was shorter than the quiescence budget: ${worker.databaseCloseSafetyDeadline}`
			);
		} finally {
			worker.postMessage({ type: 'fixture-confirm-database-close' });
			await waitFor(() => worker.databaseCloseConfirmed === true);
			worker.wasShutdown = true;
			await worker.terminate();
		}
	});

	it('records when a worker has finished closing its database handles', async function () {
		const messages = [];
		const worker = startStatusWorker(messages);
		try {
			await waitFor(() => messages.some((message) => message.type === 'fixture-ready'));
			worker.postMessage({ type: 'fixture-confirm-database-close' });
			await waitFor(() => messages.some((message) => message.type === 'fixture-database-close-confirmed'));
			assert.strictEqual(messages.find((message) => message.type === 'fixture-database-close-confirmed').closed, true);
			await waitFor(() => worker.databaseCloseConfirmed === true, {
				message: `database close not recorded; pending=${worker.databaseClosePending}; messages=${JSON.stringify(messages)}`,
			});
			assert.strictEqual(worker.databaseClosePending, false);
		} finally {
			worker.wasShutdown = true;
			await worker.terminate();
		}
	});

	it('publishes conservative then confirmed close status on a peer channel added after the startup snapshot', async function () {
		const messages = [];
		const worker = startStatusWorker(messages);
		const channel = new MessageChannel();
		const confirmedChannel = new MessageChannel();
		const peerMessages = [];
		const confirmedPeerMessages = [];
		channel.port2.on('message', (message) => peerMessages.push(message));
		confirmedChannel.port2.on('message', (message) => confirmedPeerMessages.push(message));
		try {
			await waitFor(() => messages.some((message) => message.type === 'fixture-ready'));
			worker.postMessage({ type: 'added-port', port: channel.port1, threadId: 999 }, [channel.port1]);
			await waitFor(() =>
				peerMessages.some((message) => message.type === 'worker-database-close-status' && message.pending === true)
			);
			worker.postMessage({ type: 'fixture-confirm-database-close' });
			await waitFor(() =>
				peerMessages.some((message) => message.type === 'worker-database-close-status' && message.pending === false)
			);
			await waitFor(() => worker.databaseCloseConfirmed === true);
			worker.postMessage({ type: 'added-port', port: confirmedChannel.port1, threadId: 1000 }, [
				confirmedChannel.port1,
			]);
			await waitFor(() =>
				confirmedPeerMessages.some(
					(message) => message.type === 'worker-database-close-status' && message.pending === false
				)
			);
		} finally {
			channel.port2.close();
			confirmedChannel.port2.close();
			worker.wasShutdown = true;
			await worker.terminate();
		}
	});

	it('keeps the worker alive for an unreferenced close callback after shutdown begins', async function () {
		const messages = [];
		const worker = startStatusWorker(messages);
		try {
			await waitFor(() => messages.some((message) => message.type === 'fixture-ready'));
			worker.postMessage({ type: 'fixture-close-after-shutdown' });
			await waitFor(() => messages.some((message) => message.type === 'fixture-close-after-shutdown-ready'));
			worker.wasShutdown = true;
			worker.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: 0 });
			await waitFor(() => messages.some((message) => message.type === 'fixture-deferred-database-close-confirmed'), {
				timeout: 5_000,
				message: 'worker exited before its unreferenced database-close callback ran',
			});
			await waitFor(() => worker.databaseCloseConfirmed === true);
		} finally {
			await worker.terminate();
		}
	});

	it('defers an expired ordinary shutdown backstop until database close is confirmed', async function () {
		setTerminateTimeout(50);
		const messages = [];
		const worker = startStatusWorker(messages);
		let exited = false;
		worker.once('exit', () => {
			exited = true;
		});
		try {
			await waitFor(() => messages.some((message) => message.type === 'fixture-ready'));
			const stopping = stopWorker(worker);
			await waitFor(() => worker.databaseClosePending === true);
			await new Promise((resolve) => setTimeout(resolve, 250));
			assert.strictEqual(exited, false, 'the ordinary thread timeout terminated a worker with open handles');

			worker.postMessage({ type: 'fixture-confirm-database-close' });
			await stopping;
			assert.strictEqual(exited, true);
		} finally {
			if (!exited) {
				worker.wasShutdown = true;
				await worker.terminate();
			}
		}
	});

	it('does not force-terminate a blocked worker that cannot report database-close pending', async function () {
		setTerminateTimeout(50);
		const originalRealExit = Object.getOwnPropertyDescriptor(process, '_realExit');
		const exitCodes = [];
		Object.defineProperty(process, '_realExit', {
			value: (code) => exitCodes.push(code),
			configurable: true,
		});
		const messages = [];
		const worker = startStatusWorker(messages);
		let exited = false;
		let stopping;
		let testError;
		worker.once('exit', () => {
			exited = true;
		});
		try {
			try {
				await waitFor(() => messages.some((message) => message.type === 'fixture-ready'));
				worker.postMessage({ type: 'fixture-block' });
				await waitFor(() => messages.some((message) => message.type === 'fixture-blocking'));
				stopping = stopWorker(worker);
				assert.strictEqual(worker.databaseClosePending, true, 'main must mark handle closure pending before SHUTDOWN');
				await new Promise((resolve) => setTimeout(resolve, 250));
				assert.strictEqual(exited, false, 'the ordinary timeout terminated a worker that could still own handles');
				assert.ok(worker.databaseCloseSafetyDeadline >= worker.databaseCloseStartedAt + DATABASE_QUIESCENCE_TIMEOUT_MS);
			} catch (error) {
				testError = error;
			} finally {
				try {
					if (!exited) {
						worker.wasShutdown = true;
						await worker.terminate();
					}
					await stopping;
				} catch (error) {
					testError ??= error;
				}
			}
			if (testError) throw testError;
			assert.deepStrictEqual(exitCodes, [1], 'an unconfirmed worker exit must terminate Harper');
		} finally {
			Object.defineProperty(process, '_realExit', originalRealExit);
		}
	});

	for (const extensionOrder of ['before', 'after']) {
		it(`does not shorten the database-close deadline when a drain is reported ${extensionOrder} shutdown`, async function () {
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
				await waitFor(() => worker.databaseClosePending === true);

				if (extensionOrder === 'after') {
					worker.postMessage({ type: 'fixture-extend-shutdown-deadline', deadlineMs });
					await waitFor(() => messages.some((message) => message.type === 'fixture-deadline-extended'));
				}

				await waitFor(() => worker.databaseCloseSafetyDeadline >= deadlineMs, {
					timeout: 2_000,
					message: `database-close deadline did not honor the drain extension; deadline=${worker.databaseCloseSafetyDeadline}`,
				});
			} finally {
				worker.postMessage({ type: 'fixture-confirm-database-close' });
				await waitFor(() => worker.databaseCloseConfirmed === true);
				worker.wasShutdown = true;
				await worker.terminate();
			}
		});
	}
});
