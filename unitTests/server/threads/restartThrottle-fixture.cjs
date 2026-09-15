'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');

// Long enough that an unthrottled restart has posted SHUTDOWN to every worker before the first exit.
const SHUTDOWN_HOLD_MS = 250;

parentPort.on('message', (message) => {
	if (message?.type === ITC_EVENT_TYPES.SHUTDOWN) setTimeout(() => process.exit(0), SHUTDOWN_HOLD_MS);
});
setInterval(() => {}, 10000);
parentPort.postMessage({ type: 'fixture-ready', workerCount: workerData.workerCount });
