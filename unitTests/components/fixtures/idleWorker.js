'use strict';

// Holds a pool slot until it is terminated, posting back whatever load report the test hands it.
const { parentPort } = require('node:worker_threads');

parentPort.on('message', (message) => {
	if (message?.report) parentPort.postMessage(message.report);
});
