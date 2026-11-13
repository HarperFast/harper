'use strict';

// Runs in its own process: a worker that stops with uWebSockets.js sockets open aborts the whole process,
// which must not take the mocha process with it. Exits 0 once the worker is gone and the process survived.
require('../../testUtils.js').preTestPrep();

const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { startWorker, shutdownWorkersNow, forceUwsWorkersToExit } = require('#src/server/threads/manageThreads');

const [mode, socketPath] = process.argv.slice(2);
const FIXTURE_NAME = 'uws-worker-exit-fixture';

function nextMessage(worker, type) {
	return new Promise((resolve) => {
		const onMessage = (message) => {
			if (message?.type !== type) return;
			worker.off('message', onMessage);
			resolve();
		};
		worker.on('message', onMessage);
	});
}

async function main() {
	const worker = startWorker(path.join(__dirname, 'uwsWorkerExit-worker.cjs'), {
		autoRestart: false,
		name: FIXTURE_NAME,
		env: { ...process.env, HARPER_UWS_UDS: '1', UWS_EXIT_SOCKET: socketPath },
	});
	await nextMessage(worker, 'fixture-ready');
	if (mode === 'in-flight' || mode === 'main-exit') {
		const held = nextMessage(worker, 'held');
		http.get({ socketPath, path: '/hold' }).on('error', () => {});
		await held;
	}
	if (mode === 'main-exit') {
		await forceUwsWorkersToExit();
		process.stdout.write('survived\n');
		process.exit(0);
	}
	const exited = once(worker, 'exit');
	if (mode === 'shutdown-now') await shutdownWorkersNow(FIXTURE_NAME);
	else worker.postMessage({ type: 'exit-now' });
	await exited;
	// Node's teardown of the worker runs before 'exit' is emitted; reaching here is the process surviving it.
	process.stdout.write('survived\n');
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
