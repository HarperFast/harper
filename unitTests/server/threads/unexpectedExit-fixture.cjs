'use strict';

const { parentPort } = require('node:worker_threads');
const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');

parentPort.on('message', (message) => {
	// `die` models a thread lost without a terminal write — a crash, not a shutdown handshake.
	if (message?.type === 'die') process.exit(1);
	if (message?.type === ITC_EVENT_TYPES.SHUTDOWN) process.exit(0);
});
setInterval(() => {}, 10000);
parentPort.postMessage({ type: 'fixture-ready' });
