'use strict';

const { parentPort } = require('node:worker_threads');

require('#src/utility/environment/environmentManager').initTestEnvironment();
const {
	extendShutdownDeadline,
	reportWorkerDatabaseCloseStatus,
	workerDatabasesAreClosed,
} = require('#js/server/threads/manageThreads');

parentPort.on('message', (message) => {
	if (message.type === 'fixture-block') {
		parentPort.postMessage({ type: 'fixture-blocking' });
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		return;
	}
	if (message.type === 'fixture-confirm-database-close') {
		reportWorkerDatabaseCloseStatus(true);
		reportWorkerDatabaseCloseStatus(false);
		parentPort.postMessage({ type: 'fixture-database-close-confirmed', closed: workerDatabasesAreClosed() });
		return;
	}
	if (message.type !== 'fixture-extend-shutdown-deadline') return;
	extendShutdownDeadline(message.deadlineMs);
	parentPort.postMessage({ type: 'fixture-deadline-extended' });
});

parentPort.postMessage({ type: 'fixture-ready' });
setInterval(() => {}, 10_000);
