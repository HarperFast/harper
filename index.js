const worker_threads = require('node:worker_threads');
if (!worker_threads.isMainThread) {
	// Prevents server from starting in worker threads if this was directly imported from a non-server user thread
	if (!worker_threads.workerData) worker_threads.workerData = {};
	worker_threads.workerData.noServerStart = true;
}
const { globals } = require('./server/threads/threadServer');
// these are all overwritten by the globals, but need to be here so that Node's static
// exports parser can analyze them
exports.Resource = undefined;
exports.tables = {};
exports.databases = {};
exports.getUser = undefined;
exports.server = {};
exports.contentTypes = null;
exports.threads = [];
exports.logger = {};
Object.assign(exports, globals);
