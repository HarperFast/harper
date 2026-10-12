'use strict';

const assert = require('node:assert');
const path = require('node:path');

const { startWorker } = require('#js/server/threads/manageThreads');

const WORKER_FIXTURE = path.join(__dirname, 'workerSourceMaps-fixture.cjs');

async function getWorkerReport() {
	let worker;
	try {
		return await new Promise((resolve, reject) => {
			worker = startWorker(WORKER_FIXTURE, {
				name: 'source-maps-test',
				autoRestart: false,
				onStarted(spawned) {
					spawned.on('message', (message) => message.type !== 'os-thread-id' && resolve(message));
					spawned.once('error', reject);
					spawned.once('exit', (code) => reject(new Error(`Worker exited before reporting (code ${code})`)));
				},
			});
		});
	} finally {
		if (worker) {
			worker.wasShutdown = true;
			await worker.terminate();
		}
	}
}

describe('worker source maps', () => {
	const originallyEnabled = process.sourceMapsEnabled;

	after(() => process.setSourceMapsEnabled(originallyEnabled));

	it('are off in workers when the parent has them off', async function () {
		this.timeout(30000);
		// NODE_OPTIONS reaches workers regardless of execArgv
		if (process.env.NODE_OPTIONS?.includes('--enable-source-maps')) this.skip();
		process.setSourceMapsEnabled(false);
		const report = await getWorkerReport();
		assert.strictEqual(report.sourceMapsEnabled, false);
		assert.strictEqual(report.execArgv.includes('--enable-source-maps'), false);
	});

	it('follow the parent into workers when it has them on', async function () {
		this.timeout(30000);
		process.setSourceMapsEnabled(true);
		const report = await getWorkerReport();
		assert.strictEqual(report.sourceMapsEnabled, true);
		assert.strictEqual(report.execArgv.includes('--enable-source-maps'), true);
	});
});
