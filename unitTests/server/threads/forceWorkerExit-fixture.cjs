'use strict';

// Exits with code 7 on FORCE_EXIT when FORCE_EXIT_FIXTURE_HONORS is set, so a test can tell a self-exit from
// terminate() (code 1); otherwise it ignores the request, as a worker whose event loop never gets to it would.
const { parentPort } = require('node:worker_threads');

parentPort.on('message', (message) => {
	if (message?.type === 'force-exit' && process.env.FORCE_EXIT_FIXTURE_HONORS) process.exit(7);
});
setInterval(() => {}, 10000);
parentPort.postMessage({ type: 'fixture-ready' });
