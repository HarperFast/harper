'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');
const assert = require('node:assert/strict');

const FIXTURE = path.join(__dirname, 'workerProcessGuard-fixture.js');

function spawnFixture() {
	const worker = new Worker(FIXTURE);
	const ready = new Promise((resolve, reject) => {
		worker.once('error', reject);
		worker.once('message', (msg) => {
			if (msg.type === 'ready') resolve();
			else reject(new Error(`unexpected first message: ${JSON.stringify(msg)}`));
		});
	});
	return { worker, ready };
}

async function sendAndAwait(worker, signal) {
	return new Promise((resolve, reject) => {
		worker.once('error', reject);
		worker.once('message', resolve);
		worker.postMessage(signal);
	});
}

async function shutdown(worker) {
	worker.postMessage('shutdown');
	await new Promise((resolve) => worker.once('exit', resolve));
}

describe('workerProcessGuard', () => {
	describe('main thread behavior', () => {
		it('exposes process._realExit and does not override process.exit on the main thread', () => {
			const originalExit = process.exit;
			// Load via the same alias the production code uses.
			require('#src/server/threads/workerProcessGuard');
			assert.equal(typeof process._realExit, 'function', 'process._realExit should be defined');
			// The guard installs _realExit as a bound copy, so we cannot assert reference equality
			// to the original. The worker-thread tests below cover real exit semantics by using
			// `process._realExit(0)` to terminate the fixture worker.
			assert.equal(process.exit, originalExit, 'process.exit should not be overridden on the main thread');
		});
	});

	describe('worker thread behavior', () => {
		it('intercepts process.exit() so the worker stays alive', async () => {
			const { worker, ready } = spawnFixture();
			await ready;
			try {
				const message = await sendAndAwait(worker, 'try-exit');
				assert.equal(message.type, 'survived-exit');
				assert.equal(message.exitWasOverridden, true, 'process.exit should be replaced in workers');
				assert.equal(message.realExitIsFunction, true, 'process._realExit should be a function in workers');
			} finally {
				await shutdown(worker);
			}
		});

		it('keeps the worker alive after an unhandled rejection', async () => {
			const { worker, ready } = spawnFixture();
			await ready;
			try {
				const message = await sendAndAwait(worker, 'trigger-unhandled-rejection');
				assert.equal(message.type, 'survived-rejection');
			} finally {
				await shutdown(worker);
			}
		});

		it('keeps the worker alive when a framework handler calls process.exit() from unhandledRejection', async () => {
			const { worker, ready } = spawnFixture();
			await ready;
			try {
				const message = await sendAndAwait(worker, 'try-exit-from-rejection');
				assert.equal(message.type, 'survived-framework-exit');
			} finally {
				await shutdown(worker);
			}
		});
	});
});
