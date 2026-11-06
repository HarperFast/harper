'use strict';

const { parentPort } = require('node:worker_threads');

parentPort.postMessage('ready');
parentPort.on('message', (message) => {
	if (message?.type !== 'shutdown') return;
	parentPort.postMessage({ shutdownExitDeadline: message.exitDeadline });
	setTimeout(() => process.exit(0), 10);
});
setInterval(() => {}, 10000);
