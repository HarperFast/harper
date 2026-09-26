'use strict';

const { parentPort } = require('node:worker_threads');
const { ITC_EVENT_TYPES } = require('#src/utility/hdbTerms');
const {
	broadcastWithAcknowledgement,
	broadcastWithStrictAcknowledgement,
	notifyJobCleanupComplete,
	onMessageFromWorkers,
} = require('#js/server/threads/manageThreads');
const { databaseDropPreparationSnapshot } = require('#src/resources/databaseDropPreparation');
let acknowledgementCount = 0;

parentPort.on('message', (message) => {
	if (message.type === 'send-probe') {
		broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, message.timeout).then(() =>
			parentPort.postMessage({ type: 'probe-settled' })
		);
	} else if (message.type === 'send-strict-probe') {
		broadcastWithStrictAcknowledgement({ type: 'diagnostic-probe' }, message.timeout, true).then(
			() => parentPort.postMessage({ type: 'strict-probe-settled' }),
			(error) =>
				parentPort.postMessage({
					type: 'strict-probe-rejected',
					error: `${error.message}: ${(error.errors || []).map((nested) => nested.message).join('; ')}`,
				})
		);
	}
});

onMessageFromWorkers((message, port) => {
	if (!message.requestId || !port) return;
	if (process.argv.includes('--report-acknowledge')) {
		port.postMessage({ type: 'fixture-received', requestId: message.requestId });
		port.postMessage({ type: 'ack', id: message.requestId });
	} else if (process.argv.includes('--acknowledge')) {
		port.postMessage({ type: 'ack', id: message.requestId });
	} else if (process.argv.includes('--reject')) {
		port.postMessage({ type: 'ack', id: message.requestId, error: { message: 'fixture preparation failed' } });
	} else if (process.argv.includes('--reject-conflict')) {
		port.postMessage({
			type: 'ack',
			id: message.requestId,
			error: {
				name: 'DatabaseDroppingError',
				message: 'fixture database is already being dropped',
				code: 'DATABASE_DROP_IN_PROGRESS',
				statusCode: 409,
			},
		});
	} else if (process.argv.includes('--reject-retryable')) {
		port.postMessage({
			type: 'ack',
			id: message.requestId,
			error: {
				name: 'DatabaseDrainTimeoutError',
				message: 'fixture database drain timed out',
				code: 'DATABASE_DRAIN_TIMEOUT',
				statusCode: 503,
				retryable: true,
			},
		});
	} else if (process.argv.includes('--exit-clean-parent-only')) {
		parentPort.postMessage({ type: ITC_EVENT_TYPES.JOB_CLEANUP_COMPLETE });
		clearInterval(keepAlive);
		parentPort.close();
	} else if (process.argv.includes('--report-clean-stay')) {
		notifyJobCleanupComplete();
	} else if (process.argv.includes('--exit') || process.argv.includes('--exit-clean')) {
		if (process.argv.includes('--exit-clean')) notifyJobCleanupComplete();
		clearInterval(keepAlive);
		parentPort.close();
	} else if (process.argv.includes('--ack-then-exit')) {
		if (acknowledgementCount++ === 0) port.postMessage({ type: 'ack', id: message.requestId });
		else {
			clearInterval(keepAlive);
			parentPort.close();
		}
	}
});
// manageThreads unrefs parentPort, so something must keep a non-blocking fixture alive.
const keepAlive = setInterval(() => {}, 10000);
parentPort.postMessage({ type: 'fixture-ready', databaseDropPreparations: databaseDropPreparationSnapshot() });
if (process.argv.includes('--block')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
if (process.argv.includes('--spin')) for (;;);
