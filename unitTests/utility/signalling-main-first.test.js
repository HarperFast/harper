'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { startWorker } = require('#js/server/threads/manageThreads');
const { signalSchemaChange } = require('#src/utility/signalling');
const { waitFor } = require('../waitFor');

const FIXTURE = path.join(__dirname, 'signalling-main-first-fixture.cjs');

describe('main-first schema signalling', function () {
	this.timeout(30000);

	async function expectPeerNotification(options) {
		let worker;
		try {
			const ready = new Promise((resolve, reject) => {
				worker = startWorker(FIXTURE, {
					name: 'http',
					autoRestart: false,
					onStarted(spawned) {
						spawned.on('message', (message) => {
							if (message.type === 'fixture-ready') resolve();
						});
						spawned.once('error', reject);
					},
				});
			});
			await ready;
			const received = new Promise((resolve) => {
				worker.on('message', (message) => {
					if (message.type === 'schema-received') resolve();
				});
			});

			await signalSchemaChange(
				{
					operation: 'drop_schema',
					schema: 'missing-main-first',
					database: 'missing-main-first',
					table: 'missing-table',
				},
				options
			);
			await received;
		} finally {
			if (worker) {
				worker.wasShutdown = true;
				await worker.terminate();
			}
		}
	}

	it('still notifies peers when the local catalog rescan fails', async function () {
		await expectPeerNotification({ mainFirst: true });
	});

	it('relays a destructive terminal event through main', async function () {
		await expectPeerNotification({ relayFromMain: true });
	});

	it('still attempts peer cancellation when the main-first leg rejects', async function () {
		const startReadyWorker = () => {
			const messages = [];
			let resolveReady;
			const ready = new Promise((resolve) => (resolveReady = resolve));
			const worker = startWorker(FIXTURE, {
				name: 'http',
				autoRestart: false,
				onStarted(spawned) {
					spawned.on('message', (message) => {
						messages.push(message);
						if (message.type === 'fixture-ready') resolveReady();
					});
				},
			});
			return { messages, ready, worker };
		};
		const coordinator = startReadyWorker();
		const peer = startReadyWorker();
		const workers = [coordinator.worker, peer.worker];
		try {
			await Promise.all([coordinator.ready, peer.ready]);
			coordinator.worker.postMessage({ type: 'signal-cancel-with-invalid-main-leg' });
			await waitFor(() => peer.messages.some((message) => message.type === 'cancel-received'));
			await waitFor(() => coordinator.messages.some((message) => message.type === 'signal-complete'));
			assert.strictEqual(coordinator.messages.find((message) => message.type === 'signal-complete').rejected, true);
		} finally {
			for (const worker of workers) {
				worker.wasShutdown = true;
				await worker.terminate();
			}
		}
	});
});
