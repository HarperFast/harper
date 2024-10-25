const worker_threads = require('node:worker_threads');
if (!worker_threads.isMainThread) {
	// Prevents server from starting in worker threads if this was directly imported from a non-server user thread
	if (!worker_threads.workerData) worker_threads.workerData = {};
	worker_threads.workerData.noServerStart = true;
}
const { globals } = require('./server/threads/threadServer');
Object.assign(exports, globals);
