'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');

const FIXTURE = path.join(__dirname, 'manageThreads-shutdown-fixture.js');

function spawnFixture() {
	const worker = new Worker(FIXTURE, { workerData: { addPorts: [], addThreadIds: [], restartNumber: 1 } });
	const ready = new Promise((resolve, reject) => {
		worker.once('error', reject);
		worker.once('message', (msg) => {
			if (msg.type === 'ready') resolve();
			else reject(new Error(`unexpected first message: ${JSON.stringify(msg)}`));
		});
	});
	return { worker, ready };
}

async function sendAndAwait(worker, message) {
	return new Promise((resolve, reject) => {
		worker.once('error', reject);
		worker.once('message', resolve);
		worker.postMessage(message);
	});
}

describe('manageThreads SHUTDOWN handler', () => {
	it('advances the exported restartNumber binding (not a globalThis shadow) on SHUTDOWN', async () => {
		const { worker, ready } = spawnFixture();
		await ready;
		try {
			worker.postMessage({ type: ITC_EVENT_TYPES.SHUTDOWN, restartNumber: 7 });
			const response = await sendAndAwait(worker, { type: 'query-restart-number' });
			assert.equal(
				response.value,
				7,
				'restartNumber should be updated on the real module binding so restart-interrupt checks in ' +
					'databases.ts / threadServer.ts observe it'
			);
		} finally {
			await worker.terminate();
		}
	});
});
