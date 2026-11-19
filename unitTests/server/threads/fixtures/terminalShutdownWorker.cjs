'use strict';

const { parentPort } = require('node:worker_threads');

parentPort.postMessage('ready');
parentPort.on('message', (message) => {
	if (message === 'exit') process.exit(1);
});
setInterval(() => {}, 10000);
