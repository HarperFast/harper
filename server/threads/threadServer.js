'use strict';
const { isMainThread, parentPort, threadId } = require('worker_threads');
const { Socket } = require('net');
const { createServer, IncomingMessage } = require('http');
const harper_logger = require('../../utility/logging/harper_logger');
const { join } = require('path');
const hdb_utils = require('../../utility/common_utils');
const env = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
const { server } = require('../Server');
const { WebSocketServer } = require('ws');
process.on('uncaughtException', (error) => {
	console.error('uncaughtException', error)
	process.exit(100);
});
const { loadServerModules } = require('../loadServerModules');
// log all threads as HarperDB
harper_logger.createLogFile(terms.PROCESS_LOG_NAMES.HDB, terms.HDB_PROC_DESCRIPTOR);
env.initSync();
const SERVERS = {};
exports.registerServer = registerServer;
exports.httpServer = httpServer;
if (!isMainThread) {
	loadServerModules();
	parentPort.on('message', (message) => {
		const { port, fd, data } = message;
		if (fd) {
			// Create a socket from the file descriptor for the socket that was routed to us.
			deliverSocket(fd, port, data);
		} else if (message.requestId) {
			// Windows doesn't support passing file descriptors, so we have to resort to manually proxying the socket
			// data for each request
			proxyRequest(message);
		} else if (message.type === terms.ITC_EVENT_TYPES.SHUTDOWN) {
			// shutdown (for these threads) means stop listening for incoming requests (finish what we are working) and
			// then let the event loop complete
			for (let server_type in SERVERS) {
				// TODO: If fastify has fielded a route and messed up the closing, then have to manually exit the
				//  process otherwise we can use a graceful exit
				// if (SERVERS[server_type].hasRequests)
				SERVERS[server_type].close();
				// TODO: Let fastify register as a close handler
					/*.then(() => {
					// Terminating a thread this way is really really wrong. A NodeJS thread (or process) is supposed to end
					// once it has completed all referenced work, and this allows NodeJS to property monitor for any
					// outstanding work. Violently exiting this way circumvents this, and means that there may be
					// existing work left to be done. But we have to resort to this because fastify doesn't seem to
					// capable of properly cleaning up after itself, and once it is started it will not let a thread
					// gracefully exit. Looking at fastify issues, it sounds like their cleanup operation is a mess, and
					// there are no real viable plans to fix it. We really need to rely on fastify less and move on to
					// the superior technology of directly interacting with NodeJS.
					// One thing we could also do here is try to detect if fastify has received any requests. For some
					// reason if a fastify server has not received any requests yet, we can gracefully exit properly.
					process.exit(0);
				});*/
				// else server.close() and server.closeIdleConnections()
			}
		}
	}).ref(); // use this to keep the thread running until we are ready to shutdown and clean up handles
	// notify that we are now ready to start receiving requests
	parentPort.postMessage({ type: terms.ITC_EVENT_TYPES.CHILD_STARTED });
}

function deliverSocket(fd, port, data) {
	// Create a socket and deliver it to the HTTP server
	// HTTP server likes to allow half open sockets
	let socket = new Socket({ fd, readable: true, writable: true, allowHalfOpen: true });
	// for each socket, deliver the connection to the HTTP server handler/parser
	let server = SERVERS[port];
	if (server) {
		if (typeof server === 'function') server(socket);
		else server.emit('connection', socket);
		if (data) socket.emit('data', data);
	} else {
		const retry = (retries) => {
			// in case the server hasn't registered itself yet
			setTimeout(() => {
				let server = SERVERS[port];
				if (server) {
					if (typeof server === 'function') server(socket);
					else server.emit('connection', socket);
					if (data) socket.emit('data', data);
				}
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

function registerServer(server, port) {
	if (!+port) { // if no port is provided, default to custom functions port
		port = parseInt(env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_PORT), 10);
	}
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
let default_server, http_chain, request_listeners = [], http_responders = []
function httpServer(listener, options) {
	let port = options?.port || {};
	if (!+port) { // if no port is provided, default to custom functions port
		port = parseInt(env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_PORT), 10);
	}
	if (typeof listener === 'function') {
		getDefaultHTTPServer();
		if (options?.requestOnly)
			request_listeners.push(listener);
		else
			http_responders.push(listener);
		http_chain = makeCallbackChain(request_listeners.concat(http_responders));
	} else {
		registerServer(listener, port);
	}
}
function getDefaultHTTPServer() {
	if (!default_server) {
		default_server = createServer(async (request, nodeResponse) => {
			try {
				request.nodeResponse = nodeResponse;
				// assign a more WHATWG compliant headers object, this is our real standard interface
				//request.headers = new Headers(request.headers);
				request.headers.get = get;
				let response = await http_chain(request);
				nodeResponse.writeHead(response.status, response.headers);
				let body = response.body;
				if (body?.pipe)
					body.pipe(nodeResponse);
				else
					nodeResponse.end(body);
			} catch (error) {
				nodeResponse.writeHead(500);
				nodeResponse.end(error.toString());
			}
		});
		registerServer(default_server);
	}
	return default_server;
}

function makeCallbackChain(listeners) {
	let next_callback = notFound;
	// go through the listeners in reverse order so each callback can be passed to the one before
	// and then each middleware layer can call the next middleware layer
	for (let i = listeners.length; i > 0;) {
		let listener = listeners[--i];
		let callback = next_callback;
		next_callback = (request) => {
			// for listener only layers, the response through
			return listener(request, callback);
		};
	}
	return next_callback;
}
const NOT_FOUND = {
	status: 404,
	body: 'Not found'
};
function notFound() {
	return NOT_FOUND;
}
server.http = httpServer;
server.request = (listener, options) => {
	httpServer(listener, Object.assign({ requestOnly: true}, options));
};
/**
 * Direct socket listener
 * @param listener
 * @param options
 */
server.socket = function(listener, options) {
	SERVERS[options.port] = listener;
};
let ws_listeners = [], ws_server, ws_chain;
server.ws = function(listener, options) {
	if (!ws_server) {
		ws_server = new WebSocketServer({server: getDefaultHTTPServer()});
		ws_server.on('connection', async (ws, request) => {
			let chain_completion = ws_chain(request);
			let protocol = request.headers['sec-websocket-protocol'];
			// TODO: select listener by protocol
			for (let i = 0; i < ws_listeners.length; i++) {
				let listener = ws_listeners[i];
				listener(ws, request, chain_completion);
			}
		});
	}
	ws_listeners.push(listener);
	ws_chain = makeCallbackChain(request_listeners);
}
function defaultNotFound(request, response) {
	response.writeHead(404);
	response.end('Not found\n');
}

/*let kHeaders = Symbol.for('kHeaders');
class Request extends IncomingMessage {
	get headers() {
		if (!this[kHeaders]) {
			this[kHeaders] = new Headers();

			const src = this.rawHeaders;
			const dst = this[kHeaders];

			for (let n = 0; n < this[kHeadersCount]; n += 2) {
				this._addHeaderLine(src[n + 0], src[n + 1], dst);
			}
		}
		return this[kHeaders];
	}
}*/
class Headers {
	constructor(headers) {
		this._asObject = headers;
	}
	get(name) {
		return this._asObject[name.toLowerCase()];
	}
}
function get(name) {
	return this[name.toLowerCase()];
}