'use strict';

const { parentPort } = require('node:worker_threads');

require('#src/utility/environment/environmentManager').initTestEnvironment();
const { extendShutdownDeadline } = require('#js/server/threads/manageThreads');

parentPort.on('message', (message) => {
	if (message.type !== 'fixture-extend-shutdown-deadline') return;
	extendShutdownDeadline(message.deadlineMs);
	parentPort.postMessage({ type: 'fixture-deadline-extended' });
});

parentPort.postMessage({ type: 'fixture-ready' });
setInterval(() => {}, 10_000);
