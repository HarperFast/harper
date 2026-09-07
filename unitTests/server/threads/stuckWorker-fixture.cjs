'use strict';

const { parentPort } = require('node:worker_threads');
require('#js/server/threads/manageThreads');

if (process.argv.includes('--acknowledge')) {
	parentPort.on('message', (message) => {
		if (message.requestId) parentPort.postMessage({ type: 'ack', id: message.requestId });
	});
	parentPort.postMessage({ type: 'fixture-ready' });
} else {
	parentPort.postMessage({ type: 'fixture-ready' });
	// Park the event loop for good, the way a native lock would.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
