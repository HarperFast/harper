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
const SERVERS = {};
module.exports = {
	registerServer,
};
if (!isMainThread) {
	require('../harperdb/hdbServer').hdbServer();
	const custom_func_enabled = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY);
	if (custom_func_enabled) require('../customFunctions/customFunctionsServer').customFunctionsServer();
	parentPort.on('message', (message) => {
		const { type, fd, data } = message;
		if (fd) {
			// Create a socket from the file descriptor for the socket that was routed to us.
			deliverSocket(fd, type, data);
		} else if (message.requestId) {
			// Windows doesn't support passing file descriptors, so we have to resort to manually proxying the socket
			// data for each request
			proxyRequest(message);
		} else if (type === terms.ITC_EVENT_TYPES.SHUTDOWN) {
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

function deliverSocket(fd, type, data) {
	// Create a socket and deliver it to the HTTP server
	// HTTP server likes to allow half open sockets
	let socket = new Socket({ fd, readable: true, writable: true, allowHalfOpen: true });
	// for each socket, deliver the connection to the HTTP server handler/parser
	let app_server = SERVERS[type];
	if (app_server) {
		app_server.server.emit('connection', socket);
		if (data) socket.emit('data', data);
	} else {
		const retry = (retries) => {
			// in case the server hasn't registered itself yet
			setTimeout(() => {
				let app_server = SERVERS[type];
				if (app_server) {
					app_server.server.emit('connection', socket);
					if (data) socket.emit('data', data);
				}
				else if (retries < 5) retry(retries + 1);
				else {
					harper_logger.error(`Server ${type} was not registered`);
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
	let { type, event, data, requestId } = message;
	let socket;
	socket = requestMap.get(requestId);
	switch (event) {
		case 'connection':
			socket = deliverSocket(undefined, type);
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

function registerServer(type, server) {
	SERVERS[type] = server;
}