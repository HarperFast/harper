'use strict';

const path = require('node:path');
const { startWorker } = require('#js/server/threads/manageThreads');
const { signalSchemaChange } = require('#src/utility/signalling');

const FIXTURE = path.join(__dirname, 'signalling-main-first-fixture.cjs');

describe('main-first schema signalling', function () {
	this.timeout(30000);

	it('still notifies peers when the local catalog rescan fails', async function () {
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
				{ mainFirst: true }
			);
			await received;
		} finally {
			if (worker) {
				worker.wasShutdown = true;
				await worker.terminate();
			}
		}
	});
});
