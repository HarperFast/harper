'use strict';

// Fixture executed inside a Worker thread by manageThreads-shutdown.test.js.
// Loads the real SHUTDOWN handler from manageThreads.ts and reports back the
// exported `restartNumber` binding, to guard against the handler updating a
// globalThis shadow instead of the module binding that databases.ts and
// threadServer.ts read via live ESM imports.

const { parentPort } = require('node:worker_threads');
const manageThreads = require('#src/server/threads/manageThreads');

parentPort.on('message', (message) => {
	if (message?.type === 'query-restart-number') {
		parentPort.postMessage({ type: 'restart-number', value: manageThreads.restartNumber });
	}
});

parentPort.postMessage({ type: 'ready' });
