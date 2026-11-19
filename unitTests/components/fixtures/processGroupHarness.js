'use strict';

const { startWorker } = require('#src/server/threads/manageThreads');

const worker = startWorker(require.resolve('./processGroupWorker.js'), {
	name: 'process-group-test',
	autoRestart: false,
	workerIndex: 0,
	threadCount: 1,
});
worker.on('message', async (message) => {
	if (message.type !== 'process-group-worker-ready') return;
	await worker.terminate();
	process.stdout.write('terminated\n');
});
