'use strict';

const { parentPort } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

setupTestDBPath();
setMainIsWorker(true);
const { primaryStore } = table({
	table: 'StaleRefreshOncePerKey',
	database: 'test',
	attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
});

parentPort.on('message', ({ type, id }) => {
	if (type === 'lock') parentPort.postMessage({ acquired: primaryStore.tryLock(id) });
	else if (type === 'unlock') {
		primaryStore.unlock(id);
		parentPort.postMessage({ released: !primaryStore.hasLock(id) });
	}
});
