'use strict';

const { isMainThread, parentPort, threadId } = require("worker_threads");
const { Socket } = require("net");
const harper_logger = require('../../utility/logging/harper_logger');
const hdb_utils = require("../../utility/common_utils");
const env = require("../../utility/environment/environmentManager");
const terms = require("../../utility/hdbTerms");
// log all threads as HarperDB
harper_logger.createLogFile(terms.PROCESS_LOG_NAMES.HDB, terms.HDB_PROC_DESCRIPTOR);
env.initSync();
const THREAD_TERMINATION_TIMEOUT = 10000; // threads, you got 10 seconds to die
const SERVERS = {};
module.exports = {
	registerServer,
};
if (!isMainThread) {
	require('../harperdb/hdbServer').hdbServer();
	const custom_func_enabled = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY);
	if (custom_func_enabled) require('../customFunctions/customFunctionsServer').customFunctionsServer();
	parentPort.on('message', (message) => {
		const { type, fd } = message;
		if (fd) {
			// Create a socket from the file descriptor for the socket that was routed to us. HTTP server likes to
			// allow half open sockets
			let socket = new Socket({fd, readable: true, writable: true, allowHalfOpen: true});
			// for each socket, deliver the connection to the HTTP server handler/parser
			if (SERVERS[type]) SERVERS[type].server.emit('connection', socket);
			else harper_logger.error(`Server ${type} was not registered`);
		} else if (type === terms.IPC_EVENT_TYPES.SHUTDOWN) {
			// shutdown (for these threads) means stop listening for incoming requests (finish what we are working) and
			// then let the event loop complete
			parentPort.unref(); // remove this handle
			for (let server_type in SERVERS) {
				// closing idle connections was added in v18, and is a better way to shutdown HTTP servers
				SERVERS[server_type].close();
				// in Node v18+ this is preferable way to gracefully shutdown connections
				if (SERVERS[server_type].server.closeIdleConnections()) SERVERS[server_type].server.closeIdleConnections();
			}
			setTimeout(() => {
				harper_logger.warn('Thread did not voluntarily terminate', threadId);
				// Note that if this occurs, you will probably want to replace the
				// process.exit(0); with require('why-is-node-running')(); to debug what is currently running
				process.exit(0);
			}, THREAD_TERMINATION_TIMEOUT).unref(); // don't block the shutdown
		}
	}).ref(); // use this to keep the thread running until we are ready to shutdown and clean up handles
	// notify that we are now ready to start receiving requests
	parentPort.postMessage({ type: terms.IPC_EVENT_TYPES.CHILD_STARTED });
}

function registerServer(type, server) {
	SERVERS[type] = server;
}