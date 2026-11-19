'use strict';

const { access } = require('node:fs/promises');
const { dirname } = require('node:path');
const { parentPort } = require('node:worker_threads');

const { nonInteractiveSpawn } = require('#src/components/Application');

void nonInteractiveSpawn(
	'process-group-worker',
	process.execPath,
	[process.env.HARPER_TEST_PROCESS_GROUP_WRITER],
	dirname(process.env.HARPER_TEST_PROCESS_GROUP_WRITER),
	30000
);

const readyPoll = setInterval(async () => {
	try {
		await access(process.env.HARPER_TEST_PROCESS_GROUP_OUTPUT);
		clearInterval(readyPoll);
		parentPort.postMessage({ type: 'process-group-worker-ready' });
	} catch {}
}, 10);
