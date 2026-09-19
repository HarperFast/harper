'use strict';

const { parentPort } = require('node:worker_threads');
const {
	broadcastWithAcknowledgement,
	onMessageByType,
	reportWorkerDatabaseCloseStatus,
} = require('#js/server/threads/manageThreads');

if (process.argv.includes('--schema-shutdown')) {
	require('#src/utility/environment/environmentManager').initTestEnvironment();
	require('#js/server/threads/itc');
	onMessageByType('schema', () => parentPort.postMessage({ type: 'schema-received-during-close' }));
}

onMessageByType('worker-database-close-status', (message, port) => {
	if (message.pending === false)
		parentPort.postMessage({ type: 'peer-database-close-confirmed', threadId: port?.threadId });
});

parentPort.on('message', (message) => {
	if (message.type === 'send-probe') {
		broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, message.timeout).then(() =>
			parentPort.postMessage({ type: 'probe-settled' })
		);
	} else if (message.type === 'send-strict-probe') {
		broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, message.timeout, {
			acceptWorkerDatabaseClose: true,
			includeJobWorkers: true,
			rejectOnError: true,
		}).then(
			() => parentPort.postMessage({ type: 'strict-probe-settled', rejected: false }),
			(error) => parentPort.postMessage({ type: 'strict-probe-settled', rejected: true, error: error.message })
		);
	} else if (message.type === 'confirm-database-close') {
		reportWorkerDatabaseCloseStatus(true);
		reportWorkerDatabaseCloseStatus(false);
		parentPort.postMessage({ type: 'database-close-confirmed' });
	} else if (message.type === 'begin-database-close') {
		reportWorkerDatabaseCloseStatus(true);
		parentPort.postMessage({ type: 'database-close-started' });
	} else if (message.type === 'finish-database-close') {
		reportWorkerDatabaseCloseStatus(false);
		parentPort.postMessage({ type: 'database-close-finished' });
	} else if (message.requestId && process.argv.includes('--acknowledge')) {
		parentPort.postMessage({ type: 'ack', id: message.requestId });
	} else if (message.requestId && process.argv.includes('--reject')) {
		parentPort.postMessage({ type: 'ack', id: message.requestId, error: { message: 'quiescence failed' } });
	} else if (message.requestId && process.argv.includes('--conflict')) {
		parentPort.postMessage({
			type: 'ack',
			id: message.requestId,
			error: { message: 'drop conflict', statusCode: 409 },
		});
	}
});
// manageThreads unrefs parentPort, so something must keep a non-blocking fixture alive.
setInterval(() => {}, 10000);
parentPort.postMessage({ type: 'fixture-ready' });
if (process.argv.includes('--block')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
if (process.argv.includes('--spin')) for (;;);
