'use strict';

const { parentPort } = require('node:worker_threads');

parentPort.on('message', (message) => {
	if (message?.report) parentPort.postMessage(message.report);
});
