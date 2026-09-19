'use strict';

const { parentPort } = require('node:worker_threads');
require('#js/server/threads/itc');
const { onMessageByType } = require('#js/server/threads/manageThreads');
const {
	CANCEL_DATABASE_DROP_OPERATION,
	PREPARE_DATABASE_DROP_OPERATION,
	signalSchemaChangeToPeers,
} = require('#src/utility/signalling');

onMessageByType('schema', (message) => {
	if (message.type === 'schema' && message.message?.operation === 'drop_schema') {
		parentPort.postMessage({ type: 'schema-received' });
		return;
	}
	if (message.type === 'schema' && message.message?.operation === CANCEL_DATABASE_DROP_OPERATION) {
		parentPort.postMessage({ type: 'cancel-received' });
		return;
	}
	if (message.type === 'schema' && message.message?.operation === PREPARE_DATABASE_DROP_OPERATION)
		parentPort.postMessage({ type: 'prepare-received' });
});

parentPort.on('message', async (message) => {
	const operation =
		message.type === 'signal-cancel-with-invalid-main-leg'
			? CANCEL_DATABASE_DROP_OPERATION
			: message.type === 'signal-prepare-with-invalid-main-leg'
				? PREPARE_DATABASE_DROP_OPERATION
				: undefined;
	if (!operation) return;
	try {
		await signalSchemaChangeToPeers(
			{
				operation,
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
