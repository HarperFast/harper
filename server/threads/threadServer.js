'use strict';
const { isMainThread, parentPort, threadId } = require('worker_threads');
const { Socket, createServer: createSocketServer } = require('net');
const { createServer, IncomingMessage } = require('http');
const harper_logger = require('../../utility/logging/harper_logger');
const { join } = require('path');
const hdb_utils = require('../../utility/common_utils');
const env = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
const { server } = require('../Server');
const { WebSocketServer } = require('ws');
const { TLSSocket, createSecureContext } = require('tls');
process.on('uncaughtException', (error) => {
	if (error.code === 'ECONNRESET') return; // that's what network connections do
	console.error('uncaughtException', error);
	process.exit(100);
});
env.initSync();
const SERVERS = {};
exports.registerServer = registerServer;
exports.httpServer = httpServer;
exports.deliverSocket = deliverSocket;
server.http = httpServer;
server.request = onRequest;
server.socket = onSocket;
server.ws = onWebSocket;
let ws_listeners = [],
	ws_server,
	ws_chain;
let default_server = {},
	http_chain = {},
	request_listeners = [],
	http_responders = [];

if (!isMainThread) {
	require('../loadServerModules')
		.loadServerModules(undefined, true)
		.then(() => {
			parentPort
				.on('message', (message) => {
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
						for (let port in SERVERS) {
							// TODO: If fastify has fielded a route and messed up the closing, then have to manually exit the
							//  process otherwise we can use a graceful exit
							// if (SERVERS[server_type].hasRequests)
							SERVERS[port] // TODO: Should we try to interact with fastify here?
								.close?.(() => {
									setTimeout(() => {
										console.error('Had to forcefully exit the thread');
										process.exit(0);
									}, 2000).unref();
								});
							SERVERS[port].closeIdleConnections?.();
						}
					}
				})
				.ref(); // use this to keep the thread running until we are ready to shutdown and clean up handles
			// notify that we are now ready to start receiving requests
			parentPort.postMessage({ type: terms.ITC_EVENT_TYPES.CHILD_STARTED });
		});
}

function deliverSocket(fd, port, data) {
	// Create a socket and deliver it to the HTTP server
	// HTTP server likes to allow half open sockets
	let socket = fd >= 0 ? new Socket({ fd, readable: true, writable: true, allowHalfOpen: true }) : fd;
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
				} else if (retries < 5) retry(retries + 1);
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
					event: 'destroy',
				});
			};
			break;
		case 'data':
			if (!socket._readableState.destroyed) socket.emit('data', Buffer.from(data, 'latin1'));
			break;
		case 'drain':
			if (!socket._readableState.destroyed) socket.emit('drain', {});
			break;
		case 'end':
			if (!socket._readableState.destroyed) socket.emit('end', {});
			break;
		case 'error':
			if (!socket._readableState.destroyed) socket.emit('error', {});
			break;
	}
}

function registerServer(server, port) {
	if (!+port) {
		// if no port is provided, default to custom functions port
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
function httpServer(listener, options) {
	let port = options?.port;
	let port_num = +port;
	if (!port_num) {
		// if no port is provided, default to custom functions port
		port_num = parseInt(env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_PORT), 10);
	}
	getHTTPServer(port_num);
	if (typeof listener === 'function') {
		http_responders.push({ listener, port: port || port_num });
	} else {
		registerServer(listener, port_num);
	}
	http_chain[port_num] = makeCallbackChain(http_responders, port_num);
	ws_chain = makeCallbackChain(request_listeners, port_num);
}
function getHTTPServer(port) {
	if (!default_server[port]) {
		default_server[port] = createServer(async (node_request, node_response) => {
			try {
				let request = new Request(node_request);
				// assign a more WHATWG compliant headers object, this is our real standard interface
				let response = await http_chain[port](request);
				if (response.status === -1) {
					// This means the HDB stack didn't handle the request, and we can then cascade the request
					// to the server-level handler, forming the bridge to the slower legacy fastify framework that expects
					// to interact with a node HTTP server object.
					return default_server[port].emit('unhandled', node_request, node_response);
				}
				node_response.writeHead(response.status, response.headers);
				let body = response.body;
				// if it is a stream, pipe it
				if (body?.pipe) body.pipe(node_response);
				// else just send the buffer/string
				else node_response.end(body);
			} catch (error) {
				node_response.writeHead(error.hdb_resp_code || 500);
				node_response.end(error.toString());
				harper_logger.error(error);
			}
		});
		registerServer(default_server[port], port);
	}
	return default_server[port];
}

function makeCallbackChain(responders, port_num) {
	let next_callback = unhandled;
	// go through the listeners in reverse order so each callback can be passed to the one before
	// and then each middleware layer can call the next middleware layer
	for (let i = responders.length; i > 0; ) {
		let { listener, port } = responders[--i];
		if (port === port_num || port === 'all') {
			let callback = next_callback;
			next_callback = (request) => {
				// for listener only layers, the response through
				return listener(request, callback);
			};
		}
	}
	return next_callback;
}
const UNHANDLED = {
	status: -1,
	body: 'Not found',
	headers: {},
};
function unhandled(request) {
	if (request.user) {
		// pass on authentication information to the next server
		request[node_request_key].user = request.user;
	}
	return UNHANDLED;
}
function onRequest(listener, options) {
	httpServer(listener, Object.assign({ requestOnly: true }, options));
}
/**
 * Direct socket listener
 * @param listener
 * @param options
 */
function onSocket(listener, options) {
	if (options.secure) {
		const secureContext = createSecureContext({
			// TODO: Get the certificates
		});
		const TLS_options = {
			isServer: true,
			secureContext,
		};
		SERVERS[options.port] = (socket) => {
			// TODO: Do we need to wait for secureConnect to notify listener?
			listener(new TLSSocket(socket, TLS_options));
		};
	} else SERVERS[options.port] = listener;
}
function onWebSocket(listener, options) {
	let port_num = +options?.port;
	if (!port_num) {
		// if no port is provided, default to custom functions port
		port_num = parseInt(env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_PORT), 10);
	}
	if (!ws_server) {
		ws_server = new WebSocketServer({ server: getHTTPServer(port_num) });
		ws_server.on('connection', async (ws, node_request) => {
			let request = new Request(node_request);
			request.isWebSocket = true;
			let chain_completion = http_chain[port_num](request);
			let protocol = request.headers['sec-websocket-protocol'] || '';
			// TODO: select listener by protocol
			for (let i = 0; i < ws_listeners.length; i++) {
				let handler = ws_listeners[i];
				if (handler.protocol === protocol || handler.protocol === '*') handler.listener(ws, request, chain_completion);
			}
		});
	}
	let protocol = options?.subProtocol || '';
	ws_listeners.push({ listener, protocol });
	http_chain[port_num] = makeCallbackChain(http_responders, port_num);
}
function defaultNotFound(request, response) {
	response.writeHead(404);
	response.end('Not found\n');
}
const node_request_key = Symbol('node request');
/**
 * We define our own request class, to ensure that it has integrity against leaks in a secure environment
 * and for better conformance to WHATWG standards.
 */
class Request {
	[node_request_key];
	#body;
	constructor(node_request) {
		this.method = node_request.method;
		let url = node_request.url;
		this[node_request_key] = node_request;
		let question_index = url.indexOf('?');
		if (question_index > -1) {
			this.pathname = url.slice(0, question_index);
			this.search = url.slice(question_index);
		} else {
			this.pathname = url;
			this.search = '';
		}
		this.headers = node_request.headers;
		this.headers.get = get;
	}
	get url() {
		return this.protocol + '://' + this.host + this.pathname + this.search;
	}
	get protocol() {
		return this[node_request_key].socket.encrypted ? 'https' : 'http';
	}
	get ip() {
		return this[node_request_key].socket.remoteAddress;
	}
	get body() {
		return this.#body || (this.#body = new RequestBody(this[node_request_key]));
	}
	get host() {
		return this[node_request_key].authority || this[node_request_key].headers.host;
	}
	get isAborted() {
		// TODO: implement this
		return false;
	}
}
class RequestBody {
	#node_request;
	constructor(node_request) {
		this.#node_request = node_request;
	}
	on(event, listener) {
		this.#node_request.on(event, listener);
		return this;
	}
}
function get(name) {
	return this[name.toLowerCase()];
}
