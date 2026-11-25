// A worker thread of the test process: its table class has no id incrementer of its own yet.
require('../../testUtils');
const { parentPort, workerData } = require('node:worker_threads');
const { setupTestDBPath } = require('../../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

setupTestDBPath();
setMainIsWorker(true);
const IdTable = table(workerData.definition);
parentPort
	.on('message', (message) => {
		if (message.type === 'shutdown') process.exit(0);
		if (message.type === 'newId') {
			const id = IdTable.getNewId();
			const allocation = IdTable.primaryStore.getEntry(Symbol.for('id_allocation'))?.value;
			parentPort.postMessage({ id, start: allocation?.start, end: allocation?.end });
		}
	})
	.ref();
