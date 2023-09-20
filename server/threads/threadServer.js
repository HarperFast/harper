'use strict';
const { isMainThread, parentPort, threadId } = require('worker_threads');
const { Socket } = require('net');
const { createServer, IncomingMessage } = require('http');
const { createServer: createSecureServer } = require('https');
const { readFileSync } = require('fs');
const harper_logger = require('../../utility/logging/harper_logger');
const env = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
const { server } = require('../Server');
const { WebSocketServer } = require('ws');
const { createServer: createSecureSocketServer } = require('tls');
const { getTicketKeys } = require('./manageThreads');
const { Headers } = require('../serverHelpers/Headers');
const { recordAction, recordActionBinary } = require('../../resources/analytics');
const { Request, node_request_key } = require('../serverHelpers/Request');

process.on('uncaughtException', (error) => {
	if (error.code === 'ECONNRESET') return; // that's what network connections do
	console.error('uncaughtException', error);
});
const { HDB_SETTINGS_NAMES, CONFIG_PARAMS } = terms;
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
	ws_servers = [],
	ws_chain;
let http_servers = {},
	http_chain = {},
	request_listeners = [],
	http_responders = [];

if (!isMainThread) {
	require('../loadRootComponents')
		.loadRootComponents(true)
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
							const server = SERVERS[port];
							server // TODO: Should we try to interact with fastify here?
								.close?.(() => {
									// if we are cleaning up after fastify, it will fail to release all its refs
									// and so normally we have to kill the thread forcefully, unfortunately.
									// If that is the case, do it relatively quickly, there is no sense in waiting
									// otherwise we can expect a more graceful exit and only forcefully exit after
									// a longer timeout (and log it as warning since it would be unusual).
									setTimeout(
										() => {
											if (!server.cantCleanupProperly)
												harper_logger.warn('Had to forcefully exit the thread', threadId);
											process.exit(0);
										},
										server.cantCleanupProperly ? 2500 : 5000
									).unref();
								});
							server.closeIdleConnections?.();
						}
					}
				})
				.ref(); // use this to keep the thread running until we are ready to shutdown and clean up handles
			// notify that we are now ready to start receiving requests
			parentPort.postMessage({ type: terms.ITC_EVENT_TYPES.CHILD_STARTED });
		});
}

function deliverSocket(fd_or_socket, port, data) {
	// Create a socket and deliver it to the HTTP server
	// HTTP server likes to allow half open sockets
	let socket = fd_or_socket?.read
		? fd_or_socket
		: new Socket({ fd: fd_or_socket, readable: true, writable: true, allowHalfOpen: true });
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
					socket.destroy();
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
		last_server.on('unhandled', (request, response) => {
			// fastify can't clean up properly, and as soon as we have received a fastify request, must mark our mode
			// as such
			if (server.cantCleanupProperly) existing_server.cantCleanupProperly = true;
			server.emit('request', request, response);
		});
		existing_server.lastServer = server;
	} else {
		SERVERS[port] = server;
	}
	server.on('unhandled', defaultNotFound);
}
function getPorts(options) {
	let ports = [];
	let port_num = parseInt(options?.securePort);
	if (port_num) ports.push({ port: port_num, secure: true });
	port_num = parseInt(options?.port);
	if (port_num) ports.push({ port: port_num, secure: false });
	if (ports.length === 0) {
		// if no port is provided, default to custom functions port
		ports = [
			{
				port: parseInt(env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_PORT), 10),
				secure: env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HTTPS),
			},
		];
	}
	return ports;
}
function httpServer(listener, options) {
	for (let { port, secure } of getPorts(options)) {
		getHTTPServer(port, secure, options?.isOperationsServer);
		if (typeof listener === 'function') {
			http_responders[options?.runFirst ? 'unshift' : 'push']({ listener, port: options?.port || port });
		} else {
			registerServer(listener, port);
		}
		http_chain[port] = makeCallbackChain(http_responders, port);
		ws_chain = makeCallbackChain(request_listeners, port);
	}
}
function getHTTPServer(port, secure, is_operations_server) {
	if (!http_servers[port]) {
		const server_prefix = is_operations_server ? 'operationsapi' : 'customfunctions';
		let options = {
			keepAliveTimeout: env.get(server_prefix + '_network_keepalivetimeout'),
			headersTimeout: env.get(server_prefix + '_network_headerstimeout'),
			requestTimeout: env.get(server_prefix + '_network_timeout'),
		};
		if (secure) {
			const privateKey = env.get(server_prefix + '_tls_privatekey');
			const certificate = env.get(server_prefix + '_tls_certificate');
			const certificateAuthority = env.get(server_prefix + '_tls_certificateauthority');

			Object.assign(options, {
				key: readFileSync(privateKey),
				// if they have a CA, we append it, so it is included
				cert: readFileSync(certificate) + (certificateAuthority ? '\n\n' + readFileSync(certificateAuthority) : ''),
				ticketKeys: getTicketKeys(),
			});
		}
		http_servers[port] = (secure ? createSecureServer : createServer)(options, async (node_request, node_response) => {
			try {
				let start_time = performance.now();
				let request = new Request(node_request);
				if (is_operations_server) request.isOperationsServer = true;
				// assign a more WHATWG compliant headers object, this is our real standard interface
				let response = await http_chain[port](request);
				response.headers?.set?.('Server', 'HarperDB');
				if (response.status === -1) {
					// This means the HDB stack didn't handle the request, and we can then cascade the request
					// to the server-level handler, forming the bridge to the slower legacy fastify framework that expects
					// to interact with a node HTTP server object.
					for (let header_pair of response.headers || []) {
						node_response.setHeader(header_pair[0], header_pair[1]);
					}
					node_request.baseRequest = request;
					node_response.baseResponse = response;
					return http_servers[port].emit('unhandled', node_request, node_response);
				}
				const status = response.status || 200;
				const end_time = performance.now();
				const execution_time = end_time - start_time;
				if (!response.handlesHeaders) {
					const headers = response.headers;
					if (headers?.append) {
						let server_timing = `hdb;dur=${execution_time.toFixed(2)}`;
						if (response.wasCacheMiss) {
							server_timing += ', miss';
						}
						headers.append('Server-Timing', server_timing, true);
					}
					node_response.writeHead(status, headers && (headers[Symbol.iterator] ? Array.from(headers) : headers));
				}
				const handler_path = request.handlerPath;
				const method = request.method;
				recordAction(execution_time, 'duration', handler_path, method);
				recordActionBinary(status < 400, 'success', handler_path, method);

				let body = response.body;
				// if it is a stream, pipe it
				if (body?.pipe) {
					body.pipe(node_response);
					if (body.destroy)
						node_response.on('close', () => {
							body.destroy();
						});
					let bytes_sent = 0;
					body.on('data', (data) => {
						bytes_sent += data.length;
					});
					body.on('end', () => {
						recordAction(performance.now() - end_time, 'transfer', handler_path, method);
						recordAction(bytes_sent, 'bytes-sent', handler_path, method);
					});
				}
				// else just send the buffer/string
				else if (body?.then)
					body.then((body) => {
						node_response.end(body);
					}, onError);
				else node_response.end(body);
			} catch (error) {
				onError(error);
			}
			function onError(error) {
				node_response.writeHead(error.statusCode || 500);
				node_response.end(error.toString());
				// a status code is interpreted as an expected error, so just info or warn, otherwise log as error
				if (error.statusCode) {
					if (error.statusCode === 500) harper_logger.warn(error);
					else harper_logger.info(error);
				} else harper_logger.error(error);
			}
		});
		/* Should we use HTTP2 on upgrade?:
		http_servers[port].on('upgrade', function upgrade(request, socket, head) {
			wss.handleUpgrade(request, socket, head, function done(ws) {
				wss.emit('connection', ws, request);
			});
		});*/
		registerServer(http_servers[port], port);
	}
	return http_servers[port];
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
function unhandled(request) {
	if (request.user) {
		// pass on authentication information to the next server
		request[node_request_key].user = request.user;
	}
	return {
		status: -1,
		body: 'Not found',
		headers: new Headers(),
	};
}
function onRequest(listener, options) {
	httpServer(listener, { requestOnly: true, ...options });
}

/**
 * Direct socket listener
 * @param listener
 * @param options
 */
function onSocket(listener, options) {
	if (options.securePort) {
		const privateKey = env.get('customfunctions_tls_privatekey');
		const certificate = env.get('customfunctions_tls_certificate');
		const certificateAuthority = env.get('customfunctions_tls_certificateauthority');

		let socket_server = createSecureSocketServer(
			{
				key: readFileSync(privateKey),
				// if they have a CA, we append it, so it is included
				cert: readFileSync(certificate) + (certificateAuthority ? '\n\n' + readFileSync(certificateAuthority) : ''),
			},
			listener
		);

		SERVERS[options.securePort] = (socket) => {
			socket_server.emit('connection', socket);
		};
	}
	if (options.port) SERVERS[options.port] = listener;
}
// workaround for inability to defer upgrade from https://github.com/nodejs/node/issues/6339#issuecomment-570511836
Object.defineProperty(IncomingMessage.prototype, 'upgrade', {
	get() {
		return (
			'connection' in this.headers &&
			'upgrade' in this.headers &&
			this.headers.connection.startsWith('Upgrade') &&
			this.headers.upgrade.toLowerCase() == 'websocket'
		);
	},
	set(v) {},
});
function onWebSocket(listener, options) {
	for (let { port: port_num, secure } of getPorts(options)) {
		if (!ws_servers[port_num]) {
			ws_servers[port_num] = new WebSocketServer({ server: getHTTPServer(port_num, secure) });
			ws_servers[port_num].on('connection', async (ws, node_request) => {
				let request = new Request(node_request);
				request.isWebSocket = true;
				let chain_completion = http_chain[port_num](request);
				let protocol = node_request.headers['sec-websocket-protocol'] || '';
				// TODO: select listener by protocol
				for (let i = 0; i < ws_listeners.length; i++) {
					let handler = ws_listeners[i];
					if (handler.protocol) {
						// if we have a handler for a specific protocol, allow it to select on that protocol
						// to the exclusion of other handlers
						if (handler.protocol === protocol) {
							handler.listener(ws, request, chain_completion);
							break;
						}
					} else {
						handler.listener(ws, request, chain_completion);
					}
				}
			});
		}
		let protocol = options?.subProtocol || '';
		ws_listeners.push({ listener, protocol });
		http_chain[port_num] = makeCallbackChain(http_responders, port_num);
	}
}
function defaultNotFound(request, response) {
	response.writeHead(404);
	response.end('Not found\n');
}
