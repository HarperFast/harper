'use strict';
const { isMainThread, parentPort, threadId } = require('worker_threads');
const { Socket } = require('net');
const harper_logger = require('../../utility/logging/harper_logger');
const { join } = require('path');
const hdb_utils = require('../../utility/common_utils');
const env = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
process.on('uncaughtException', (error) => {
	console.error('uncaughtException', error)
	process.exit(100);
});
const { loadComponentModules } = require('../../bin/load-component-modules');
// log all threads as HarperDB
harper_logger.createLogFile(terms.PROCESS_LOG_NAMES.HDB, terms.HDB_PROC_DESCRIPTOR);
env.initSync();
const THREAD_TERMINATION_TIMEOUT = 10000; // threads, you got 10 seconds to die
const SERVERS = {};
module.exports = {
	registerServer,
};
if (!isMainThread) {
	console.log('starting from console')
	harper_logger.error('starting http thread', threadId);
	loadComponentModules();
	harper_logger.error('started http thread', threadId);
	parentPort.on('message', (message) => {
		const { port, fd } = message;
		if (fd) {
			// Create a socket from the file descriptor for the socket that was routed to us. HTTP server likes to
			// allow half open sockets
			let socket = new Socket({fd, readable: true, writable: true, allowHalfOpen: true});
			// for each socket, deliver the connection to the HTTP server handler/parser
			if (SERVERS[port]) SERVERS[port].emit('connection', socket);
			else {
				const retry = (retries) => {
					setTimeout(() => {
						if (SERVERS[port]) SERVERS[port].server.emit('connection', socket);
						else if (retries < 5) retry(retries + 1);
						else {
							harper_logger.error(`Server ${port} was not registered`);
							socket.close();
						}
					}, 1000);
				};
				retry(1);
			}
		} else if (message.type === terms.IPC_EVENT_TYPES.SHUTDOWN) {
			// shutdown (for these threads) means stop listening for incoming requests (finish what we are working) and
			// then let the event loop complete
			parentPort.unref(); // remove this handle
			for (let port in SERVERS) {
				// closing idle connections was added in v18, and is a better way to shutdown HTTP servers
				SERVERS[port].close();
				// in Node v18+ this is preferable way to gracefully shutdown connections
				if (SERVERS[port].closeIdleConnections()) SERVERS[port].server.closeIdleConnections();
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

function registerServer(port, server) {
	let existing_server = SERVERS[port];
	if (existing_server) {
		// if there is an existing server on this port, we create a cascading delegation to try the request with one
		// server and if doesn't handle the request, cascade to next server (until finally we 404)
		let last_server = existing_server.lastServer || existing_server;
		last_server.off('unhandled', defaultNotFound);
		last_server.on('unhandled', (request, response) => server.emit('request', request, response));
		existing_server.lastServer = server;
	} else {
		SERVERS[port] = server;
	}
	server.on('unhandled', defaultNotFound);
}
function defaultNotFound(request, response) {
	response.writeHead(404);
	response.end('Not found\n');
}