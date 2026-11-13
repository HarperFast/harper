'use strict';

const { parentPort } = require('node:worker_threads');
const { realExit } = require('#src/server/threads/workerProcessGuard');
require('#src/server/threads/manageThreads');
const { createUwsServer } = require('#src/server/serverHelpers/uwsServer');

createUwsServer({
	socketPath: process.env.UWS_EXIT_SOCKET,
	handler(request) {
		if (request.pathname !== '/hold') return { status: 200, body: 'ok' };
		parentPort.postMessage({ type: 'held' });
		return new Promise(() => {});
	},
}).then(() => parentPort.postMessage({ type: 'fixture-ready' }));

parentPort.on('message', (message) => {
	if (message?.type === 'exit-now') realExit(0);
});
setInterval(() => {}, 10000);
