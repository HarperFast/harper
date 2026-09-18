'use strict';

const { parentPort } = require('node:worker_threads');
require('#js/server/threads/itc');

parentPort.on('message', (message) => {
	if (message.type === 'schema' && message.message?.operation === 'drop_schema')
		parentPort.postMessage({ type: 'schema-received' });
});

setInterval(() => {}, 10000);
parentPort.postMessage({ type: 'fixture-ready' });
