'use strict';

const assert = require('node:assert');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Worker } = require('node:worker_threads');

const FIXTURE = join(__dirname, 'threadServerStartupLiveness-fixture.js');

describe('threadServer startup liveness', () => {
	it('keeps a pre-ready worker alive while component loading has no ref-holding completion source', async () => {
		const storagePath = mkdtempSync(join(tmpdir(), 'harper-worker-liveness-'));
		const config = readFileSync(join(__dirname, '../../../static/defaultConfig.yaml'), 'utf8')
			.replace(/^  file: true$/m, '  file: false')
			.replace(/^  root: null$/m, `  root: ${JSON.stringify(storagePath)}`)
			.replace(/^rootPath: null$/m, `rootPath: ${JSON.stringify(storagePath)}`)
			.replace(/^  path: null$/m, `  path: ${JSON.stringify(storagePath)}`);
		writeFileSync(join(storagePath, 'harper-config.yaml'), config);
		let worker;
		try {
			worker = new Worker(FIXTURE, {
				workerData: { addPorts: [], addThreadIds: [], noServerStart: true, storagePath },
			});
			const message = await new Promise((resolve, reject) => {
				const timeout = setTimeout(() => finish(new Error('worker did not report ready')), 15_000);
				const onError = (error) => finish(error);
				const onExit = (code) => finish(new Error(`worker exited with code ${code} before reporting ready`));
				const onMessage = (message) => {
					if (message.type === 'child_started') finish(null, message);
				};
				function finish(error, message) {
					clearTimeout(timeout);
					worker.removeListener('error', onError);
					worker.removeListener('exit', onExit);
					worker.removeListener('message', onMessage);
					if (error) reject(error);
					else resolve(message);
				}
				worker.on('error', onError);
				worker.on('exit', onExit);
				worker.on('message', onMessage);
			});
			assert.equal(message.type, 'child_started');
		} finally {
			await worker?.terminate();
			rmSync(storagePath, { recursive: true, force: true });
		}
	});
});
