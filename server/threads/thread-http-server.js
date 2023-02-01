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
			// Create a socket from the file descriptor for the socket that was routed to us.
			deliverSocket(fd, port);
		} else if (message.requestId) {
			// Windows doesn't support passing file descriptors, so we have to resort to manually proxying the socket
			// data for each request
			proxyRequest(message);
		} else if (message.type === terms.ITC_EVENT_TYPES.SHUTDOWN) {
			// shutdown (for these threads) means stop listening for incoming requests (finish what we are working) and
			// then let the event loop complete
			for (let server_type in SERVERS) {
				// closing idle connections was added in v18, and is a better way to shutdown HTTP servers
				SERVERS[server_type].close();
				// in Node v18+ this is preferable way to gracefully shutdown connections
				if (SERVERS[server_type].server.closeIdleConnections()) SERVERS[server_type].server.closeIdleConnections();
			}
		}
	}).ref(); // use this to keep the thread running until we are ready to shutdown and clean up handles
	// notify that we are now ready to start receiving requests
	parentPort.postMessage({ type: terms.ITC_EVENT_TYPES.CHILD_STARTED });
}

function deliverSocket(fd, port) {
	// Create a socket and deliver it to the HTTP server
	// HTTP server likes to allow half open sockets
	let socket = new Socket({ fd, readable: true, writable: true, allowHalfOpen: true });
	// for each socket, deliver the connection to the HTTP server handler/parser
	if (SERVERS[port]) SERVERS[port].server.emit('connection', socket);
	else {
		const retry = (retries) => {
			// in case the server hasn't registered itself yet
			setTimeout(() => {
				if (SERVERS[port]) SERVERS[port].server.emit('connection', socket);
				else if (retries < 5) retry(retries + 1);
				else {
					harper_logger.error(`Server on port ${port} was not registered`);
					socket.close();
				}
			}, 1000);
		};
		retry(1);
	}
	return socket;
}

let requestMap = new Map();
function proxyRequest(message) {
	let { port, event, data, requestId } = message;
	let socket;
	socket = requestMap.get(requestId);
	switch (event) {
		case 'connection':
			socket = deliverSocket(undefined, port);
			requestMap.set(requestId, socket);
			socket.write = (data, encoding, callback) => {
				parentPort.postMessage({
					requestId,
					event: 'data',
					data: data.toString('latin1'),
				});
				if (callback) callback();
				return true;
			};
			socket.end = (data, encoding, callback) => {
				parentPort.postMessage({
					requestId,
					event: 'end',
					data: data?.toString('latin1'),
				});
				if (callback) callback();
				return true;
			};
			let originalDestroy = socket.destroy;
			socket.destroy = () => {
				originalDestroy.call(socket);
				parentPort.postMessage({
					requestId,
					event: 'destroy'
				});
			};
			break;
		case 'data':
			if (!socket._readableState.destroyed)
				socket.emit('data', Buffer.from(data, 'latin1'));
			break;
		case 'drain':
			if (!socket._readableState.destroyed)
				socket.emit('drain', {});
			break;
		case 'end':
			if (!socket._readableState.destroyed)
				socket.emit('end', {});
			break;
		case 'error':
			if (!socket._readableState.destroyed)
				socket.emit('error', {});
			break;
	}
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