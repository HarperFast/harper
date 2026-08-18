'use strict';

const { parentPort } = require('node:worker_threads');
require('#js/server/threads/manageThreads');

setInterval(() => {}, 10000);

parentPort.postMessage({
	ports: [...global.threads].map((port) => ({
		threadId: port.threadId,
		isJobWorker: port.isJobWorker === true,
	})),
	eligibleThreadIds: global.threads.filter((port) => !port.isJobWorker).map((port) => port.threadId),
});
