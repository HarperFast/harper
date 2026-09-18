'use strict';

const { parentPort } = require('node:worker_threads');
require('#js/server/threads/itc');
const { onMessageByType } = require('#js/server/threads/manageThreads');
const { CANCEL_DATABASE_DROP_OPERATION, signalSchemaChangeToPeers } = require('#src/utility/signalling');

onMessageByType('schema', (message) => {
	if (message.type === 'schema' && message.message?.operation === 'drop_schema') {
		parentPort.postMessage({ type: 'schema-received' });
		return;
	}
	if (message.type === 'schema' && message.message?.operation === CANCEL_DATABASE_DROP_OPERATION) {
		parentPort.postMessage({ type: 'cancel-received' });
	}
});

parentPort.on('message', async (message) => {
	if (message.type !== 'signal-cancel-with-invalid-main-leg') return;
	try {
		await signalSchemaChangeToPeers(
			{
				operation: CANCEL_DATABASE_DROP_OPERATION,
				schema: 'missing-main-first',
			},
			{ mainFirst: true, rejectOnError: true }
		);
		parentPort.postMessage({ type: 'signal-complete', rejected: false });
	} catch {
		parentPort.postMessage({ type: 'signal-complete', rejected: true });
	}
});

setInterval(() => {}, 10000);
parentPort.postMessage({ type: 'fixture-ready' });
