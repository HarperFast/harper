'use strict';
const { parentPort, threadId, workerData } = require('node:worker_threads');
workerData.noServerStart = true;
const { onMessageByType } = require('#js/server/threads/manageThreads');
const {
	reserveFullTextContinuation,
	releaseFullTextContinuation,
	fullTextContinuationDeadline,
} = require('#src/resources/indexes/fullTextContinuation');
const claims = [];
onMessageByType('full-text-admission-test-command', async (event) => {
	try {
		if (event.message.operation === 'reserve')
			claims.push(await reserveFullTextContinuation(128, fullTextContinuationDeadline()));
		else if (event.message.operation === 'release') await releaseFullTextContinuation(claims.pop().id);
		parentPort.postMessage({
			type: 'full-text-admission-test-response',
			message: { originator: threadId, count: claims.length },
		});
	} catch (error) {
		parentPort.postMessage({
			type: 'full-text-admission-test-response',
			message: { originator: threadId, error: error.message, status: error.statusCode },
		});
	}
});
parentPort.ref();
parentPort.postMessage({ type: 'full-text-admission-test-response', message: { originator: threadId, ready: true } });
