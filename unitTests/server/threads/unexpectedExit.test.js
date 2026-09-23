'use strict';

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const { startWorker, stopWorker, workers } = require('#js/server/threads/manageThreads');

const FIXTURE = path.join(__dirname, 'unexpectedExit-fixture.cjs');

// A deliberate stop already has an owner — a replacement, or the process teardown — so only a death
// nothing accounted for reaches the hook.
describe('startWorker onUnexpectedExit', function () {
	this.timeout(60000);

	it('fires when a worker dies on its own', async function () {
		const exits = [];
		const worker = await startFixtureWorker(exits);
		try {
			worker.postMessage({ type: 'die' });
			await once(worker, 'exit');
			assert.deepStrictEqual(exits, [worker]);
		} finally {
			await cleanUp([worker]);
		}
	});

	it('does not fire for a deliberate stop', async function () {
		const exits = [];
		const worker = await startFixtureWorker(exits);
		await stopWorker(worker);
		assert.deepStrictEqual(exits, [], 'a stopped worker is already someone else’s responsibility');
	});

	// A handler that fails must not take the process down with the thread — a throw inside an 'exit'
	// listener is uncaught, and an async handler's rejection is unhandled.
	for (const [kind, handler] of [
		[
			'throws',
			() => {
				throw new Error('handler blew up');
			},
		],
		[
			'rejects',
			async () => {
				throw new Error('handler blew up');
			},
		],
	]) {
		it(`contains a handler that ${kind}`, async function () {
			const unhandled = [];
			const record = (reason) => unhandled.push(reason);
			process.on('unhandledRejection', record);
			const worker = await startFixtureWorker([], handler);
			try {
				worker.postMessage({ type: 'die' });
				await once(worker, 'exit');
				await new Promise((resolve) => setImmediate(resolve));
				assert.deepStrictEqual(unhandled, []);
			} finally {
				process.off('unhandledRejection', record);
				await cleanUp([worker]);
			}
		});
	}

	// A replacement can be stranded exactly like the worker it replaced.
	it('fires for a replacement started by startCopy', async function () {
		const exits = [];
		const worker = await startFixtureWorker(exits);
		const replacement = worker.startCopy();
		await once(replacement, 'message');
		try {
			replacement.postMessage({ type: 'die' });
			await once(replacement, 'exit');
			assert.deepStrictEqual(exits, [replacement]);
		} finally {
			await cleanUp([worker, replacement]);
		}
	});
});

function startFixtureWorker(exits, onUnexpectedExit = (worker) => exits.push(worker)) {
	return new Promise((resolve, reject) => {
		startWorker(FIXTURE, {
			autoRestart: false,
			name: 'unexpected-exit-fixture',
			onUnexpectedExit,
			onStarted(worker) {
				const onMessage = (message) => {
					if (message?.type !== 'fixture-ready') return;
					worker.off('message', onMessage);
					resolve(worker);
				};
				worker.on('message', onMessage);
				worker.once('error', reject);
			},
		});
	});
}

async function cleanUp(started) {
	for (const worker of started.reverse()) {
		if (!workers.includes(worker)) continue;
		worker.wasShutdown = true;
		await worker.terminate();
	}
}
