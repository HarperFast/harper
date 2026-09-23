'use strict';

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const { startWorker, stopWorker, workers } = require('#js/server/threads/manageThreads');

const FIXTURE = path.join(__dirname, 'unexpectedExit-fixture.cjs');

// `onUnexpectedExit` is what a caller with its own recovery hangs off a worker's death — the job
// runner settles the abandoned job row from it. The distinction it draws is the whole contract: a
// deliberate stop already has an owner (a replacement, or the process teardown), and only a death
// nothing accounted for is the caller's to handle.
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

	// Regression: the hook used to be attached to the worker object by the caller, so a replacement
	// `startCopy()` produced carried no hook and its death went unnoticed. Carrying it on `options`,
	// which `startCopy` reuses, is what makes the replacement inherit it.
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

function startFixtureWorker(exits) {
	return new Promise((resolve, reject) => {
		startWorker(FIXTURE, {
			autoRestart: false,
			name: 'unexpected-exit-fixture',
			onUnexpectedExit: (worker) => exits.push(worker),
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
