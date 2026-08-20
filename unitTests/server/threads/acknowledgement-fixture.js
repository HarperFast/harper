'use strict';

const { parentPort } = require('node:worker_threads');

parentPort.on('message', (message) => {
	if (message.type !== 'acknowledgement-test') return;
	if (message.action === 'timeout') return;
	if (message.action === 'close') return parentPort.close();
	parentPort.postMessage({
		type: 'ack',
		id: message.requestId,
		...(message.includeAcknowledgementResult === true ? { result: message.result } : null),
	});
});
