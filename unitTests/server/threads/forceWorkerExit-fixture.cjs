'use strict';

// code 7 tells a self-exit apart from terminate() (code 1)
const { parentPort } = require('node:worker_threads');

parentPort.on('message', (message) => {
	if (message?.type === 'force-exit' && process.env.FORCE_EXIT_FIXTURE_HONORS) process.exit(7);
});
setInterval(() => {}, 10000);
parentPort.postMessage({ type: 'fixture-ready' });
