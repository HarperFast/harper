'use strict';

const { parentPort } = require('node:worker_threads');
const { broadcastWithAcknowledgement } = require('#js/server/threads/manageThreads');

parentPort.on('message', (message) => {
	if (message.type === 'send-probe') {
		broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, message.timeout).then(() =>
			parentPort.postMessage({ type: 'probe-settled' })
		);
	} else if (message.requestId && process.argv.includes('--acknowledge')) {
		parentPort.postMessage({ type: 'ack', id: message.requestId });
	}
});
// manageThreads unrefs parentPort, so something must keep a non-blocking fixture alive.
setInterval(() => {}, 10000);
parentPort.postMessage({ type: 'fixture-ready' });
if (process.argv.includes('--block')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
if (process.argv.includes('--spin')) for (;;);
