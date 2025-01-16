'use strict';

const { isMainThread, parentPort, threadId, workerData } = require('node:worker_threads');
const { Socket, createServer: createSocketServer } = require('node:net');
const { createServer, IncomingMessage } = require('node:http');
const { createServer: createSecureServerHttp1 } = require('node:https');
const { createSecureServer } = require('node:http2');
const { unlinkSync, existsSync } = require('fs');
const harper_logger = require('../../utility/logging/harper_logger');
const env = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
const { server } = require('../Server');
const { WebSocketServer } = require('ws');
let { createServer: createSecureSocketServer } = require('node:tls');
const { getTicketKeys, restartNumber, getWorkerIndex } = require('./manageThreads');
const { Headers, appendHeader } = require('../serverHelpers/Headers');
const { recordAction, recordActionBinary } = require('../../resources/analytics');
const { Request, createReuseportFd } = require('../serverHelpers/Request');
const { checkMemoryLimit } = require('../../utility/registration/hdb_license');
const { createTLSSelector } = require('../../security/keys');
const { resolvePath } = require('../../config/configUtils');
const { startupLog } = require('../../bin/run');
const { Readable } = require('node:stream');
const globals = require('../../globals');

const debug_threads = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG);
if (debug_threads) {
	let port;
	if (isMainThread) {
		port = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG_PORT) ?? 9229;
		process.on(['SIGINT', 'SIGTERM', 'SIGQUIT', 'exit'], () => {
			try {
				require('inspector').close();
			} catch (error) {
				harper_logger.info('Could not close debugger', error);
			}
		});
	} else {
		const starting_port = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG_STARTINGPORT);
		if (starting_port && getWorkerIndex() >= 0) {
			port = starting_port + getWorkerIndex();
		}
	}
	if (port) {
		const host = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG_HOST);
		const wait_for_debugger = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG_WAITFORDEBUGGER);
		try {
			require('inspector').open(port, host, wait_for_debugger);
		} catch (error) {
			harper_logger.trace(`Could not start debugging on port ${port}, you may already be debugging:`, error.message);
		}
	}
} else if (process.env.DEV_MODE && isMainThread) {
	try {
		require('inspector').open(9229);
	} catch (error) {
		if (restartNumber <= 1)
			harper_logger.trace('Could not start debugging on port 9229, you may already be debugging:', error.message);
	}
}

process.on('uncaughtException', (error) => {
	if (error.isHandled) return;
	if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') return; // that's what network connections do
	if (error.message === 'write EIO') return; // that means the terminal is closed
	console.error('uncaughtException', error);
});
const { HDB_SETTINGS_NAMES, CONFIG_PARAMS } = terms;
env.initSync();
const session_affinity = env.get(CONFIG_PARAMS.HTTP_SESSIONAFFINITY);
const SERVERS = {};
const port_server = new Map();
exports.registerServer = registerServer;
exports.httpServer = httpServer;
exports.deliverSocket = deliverSocket;
exports.startServers = startServers;
exports.listenOnPorts = listenOnPorts;
exports.globals = globals;
exports.when_components_loaded = null;
server.http = httpServer;
server.request = onRequest;
server.socket = onSocket;
server.ws = onWebSocket;
let ws_listeners = {},
	ws_servers = {},
	ws_chain;
let http_servers = {},
	http_chain = {},
	request_listeners = [],
	http_responders = [];

function startServers() {
	return (exports.when_components_loaded = require('../loadRootComponents')
		.loadRootComponents(true)
		.then(() => {
			parentPort
				?.on('message', (message) => {
					const { port, fd, data } = message;
					if (fd) {
						// Create a socket from the file descriptor for the socket that was routed to us.
						deliverSocket(fd, port, data);
					} else if (message.requestId) {
						// Windows doesn't support passing file descriptors, so we have to resort to manually proxying the socket
						// data for each request
						proxyRequest(message);
					} else if (message.type === terms.ITC_EVENT_TYPES.SHUTDOWN) {
						harper_logger.trace('received shutdown request', threadId);
						// shutdown (for these threads) means stop listening for incoming requests (finish what we are working) and
						// close connections as possible, then let the event loop complete
						for (let port in SERVERS) {
							const server = SERVERS[port];
							let close_all_timer;
							if (server.closeIdleConnections) {
								// Here we attempt to gracefully close all outstanding keep-alive connections,
								// repeatedly closing any connections that are idle. This allows any active requests
								// to finish sending their response, then we close their connections.
								let symbols = Object.getOwnPropertySymbols(server);
								let connections_symbol = symbols.find((symbol) => symbol.description.includes('connections'));
								let close_attempts = 0;
								let timer = setInterval(() => {
									close_attempts++;
									const force_close = close_attempts >= 100;
									let connections = server[connections_symbol][force_close ? 'all' : 'idle']();
									if (connections.length === 0) {
										if (force_close) clearInterval(timer);
										return;
									}
									if (close_attempts === 1) harper_logger.info(`Closing ${connections.length} idle connections`);
									else if (force_close)
										harper_logger.warn(`Forcefully closing ${connections.length} active connections`);
									for (let i = 0, l = connections.length; i < l; i++) {
										const socket = connections[i].socket;
										if (socket._httpMessage && !socket._httpMessage.finished && !force_close) {
											continue;
										}
										if (force_close) socket.destroySoon();
										else socket.end('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n');
									}
								}, 25).unref();
							}
							// And we tell the server not to accept any more incoming connections
							server.close?.(() => {
								if (env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET) && getWorkerIndex() == 0) {
									try {
										unlinkSync(resolvePath(env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET)));
									} catch (err) {}
								}

								clearInterval(close_all_timer);
								// We hope for a graceful exit once all connections have been closed, and no
								// more incoming connections are accepted, but if we need to, we eventually will exit
								setTimeout(() => {
									console.log('forced close server', port, threadId);
									if (!server.cantCleanupProperly) harper_logger.warn('Had to forcefully exit the thread', threadId);
									process.exit(0);
								}, 5000).unref();
							});
						}
						if (debug_threads || process.env.DEV_MODE) {
							try {
								require('inspector').close();
							} catch (error) {
								harper_logger.info('Could not close debugger', error);
							}
						}
					}
				})
				.ref(); // use this to keep the thread running until we are ready to shutdown and clean up handles
			let listening;
			if (createReuseportFd && !session_affinity) {
				listening = listenOnPorts();
			}

			// notify that we are now ready to start receiving requests
			Promise.resolve(listening).then(() => {
				if (getWorkerIndex() === 0) {
					try {
						startupLog(port_server);
					} catch (err) {
						console.error('Error displaying start-up log', err);
					}
				}
				parentPort?.postMessage({ type: terms.ITC_EVENT_TYPES.CHILD_STARTED });
			});
		}));
}
function listenOnPorts() {
	const listening = [];
	for (let port in SERVERS) {
		const server = SERVERS[port];

		// If server is unix domain socket
		if (port.includes?.('/') && getWorkerIndex() == 0) {
			if (existsSync(port)) unlinkSync(port);
			listening.push(
				new Promise((resolve, reject) => {
					server
						.listen({ path: port }, () => {
							resolve({ port, name: server.name, protocol_name: server.protocol_name });
							harper_logger.info('Domain socket listening on ' + port);
						})
						.on('error', reject);
				})
			);
			continue;
		}
		let listen_on;
		const thread_range = env.get(terms.CONFIG_PARAMS.HTTP_THREADRANGE);
		if (thread_range) {
			let thread_range_array = typeof thread_range === 'string' ? thread_range.split('-') : thread_range;
			let thread_index = getWorkerIndex();
			if (thread_index < thread_range_array[0] || thread_index > thread_range_array[1]) {
				continue;
			}
		}

		let fd;
		try {
			const last_colon = port.lastIndexOf(':');
			if (last_colon > 0)
				if (createReuseportFd)
					// if there is a colon, we assume it is a host:port pair, and then strip brackets as that is a common way to
					// specify an IPv6 address
					listen_on = {
						fd: createReuseportFd(+port.slice(last_colon + 1).replace(/[\[\]]/g, ''), port.slice(0, last_colon)),
					};
				else listen_on = { host: +port.slice(last_colon + 1).replace(/[\[\]]/g, ''), port: port.slice(0, last_colon) };
			else if (createReuseportFd) listen_on = { fd: createReuseportFd(+port, '::') };
			else listen_on = { port };
		} catch (error) {
			console.error(`Unable to bind to port ${port}`, error);
			continue;
		}
		listening.push(
			new Promise((resolve, reject) => {
				server
					.listen(listen_on, () => {
						resolve({ port, name: server.name, protocol_name: server.protocol_name });
						harper_logger.trace('Listening on port ' + port, threadId);
					})
					.on('error', reject);
			})
		);
	}
	return Promise.all(listening);
}
if (!isMainThread && !workerData?.noServerStart) {
	startServers();
}

function deliverSocket(fd_or_socket, port, data) {
	// Create a socket and deliver it to the HTTP server
	// HTTP server likes to allow half open sockets
	let socket = fd_or_socket?.read
		? fd_or_socket
		: new Socket({ fd: fd_or_socket, readable: true, writable: true, allowHalfOpen: true });
	// for each socket, deliver the connection to the HTTP server handler/parser
	let server = SERVERS[port];
	if (server.isSecure) {
		socket.startTime = performance.now();
	}
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
const { getComponentName } = require('../../components/componentLoader');

function registerServer(server, port, check_port = true) {
	if (!port) {
		// if no port is provided, default to custom functions port
		port = env.get(terms.CONFIG_PARAMS.HTTP_PORT);
	}
	let existing_server = SERVERS[port];
	if (existing_server) {
		// if there is an existing server on this port, we create a cascading delegation to try the request with one
		// server and if doesn't handle the request, cascade to next server (until finally we 404)
		let last_server = existing_server.lastServer || existing_server;
		if (last_server === server) throw new Error(`Can not register the same server twice for the same port ${port}`);
		if (check_port && Boolean(last_server.sessionIdContext) !== Boolean(server.sessionIdContext) && +port)
			throw new Error(`Can not mix secure HTTPS and insecure HTTP on the same port ${port}`);
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
	let port = options?.securePort;
	if (port) ports.push({ port, secure: true });
	port = options?.port;
	if (port) ports.push({ port, secure: false });
	if (ports.length === 0) {
		// if no port is provided, default to http port
		ports = [];
		if (env.get(terms.CONFIG_PARAMS.HTTP_PORT) != null)
			ports.push({
				port: env.get(terms.CONFIG_PARAMS.HTTP_PORT),
				secure: env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HTTPS),
			});
		if (env.get(terms.CONFIG_PARAMS.HTTP_SECUREPORT) != null)
			ports.push({ port: env.get(terms.CONFIG_PARAMS.HTTP_SECUREPORT), secure: true });
	}

	if (options?.isOperationsServer && env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET)) {
		ports.push({
			port: resolvePath(env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET)),
			secure: false,
		});
	}
	return ports;
}
function httpServer(listener, options) {
	const servers = [];

	for (let { port, secure } of getPorts(options)) {
		servers.push(getHTTPServer(port, secure, options?.isOperationsServer, options?.mtls));
		if (typeof listener === 'function') {
			http_responders[options?.runFirst ? 'unshift' : 'push']({ listener, port: options?.port || port });
		} else {
			listener.isSecure = secure;
			registerServer(listener, port, false);
		}
		http_chain[port] = makeCallbackChain(http_responders, port);
		ws_chain = makeCallbackChain(request_listeners, port);
	}

	return servers;
}

function setPortServerMap(port, server) {
	const port_entry = port_server.get(port) ?? [];
	port_server.set(port, [...port_entry, server]);
}

function getHTTPServer(port, secure, is_operations_server, is_mtls) {
	setPortServerMap(port, { protocol_name: secure ? 'HTTPS' : 'HTTP', name: getComponentName() });
	if (!http_servers[port]) {
		let server_prefix = is_operations_server ? 'operationsApi_network' : 'http';
		let keepAliveTimeout = env.get(server_prefix + '_keepAliveTimeout');
		let requestTimeout = env.get(server_prefix + '_timeout');
		let headersTimeout = env.get(server_prefix + '_headersTimeout');
		let options = {
			keepAliveTimeout,
			headersTimeout,
			requestTimeout,
			// we set this higher (2x times the default in v22, 8x times the default in v20) because it can help with
			// performance
			highWaterMark: 128 * 1024,
			noDelay: true, // don't delay for Nagle's algorithm, it is a relic of the past that slows things down: https://brooker.co.za/blog/2024/05/09/nagle.html
			keepAlive: true,
			keepAliveInitialDelay: 600, // lower the initial delay to 10 minutes, we want to be proactive about closing unused connections
			maxHeaderSize: env.get(terms.CONFIG_PARAMS.HTTP_MAXHEADERSIZE),
		};
		let mtls = env.get(server_prefix + '_mtls');
		let mtls_required = env.get(server_prefix + '_mtls_required');
		let http2;

		if (secure) {
			// check if we want to enable HTTP/2; operations server doesn't use HTTP/2 because it doesn't allow the
			// ALPNCallback to work with our custom protocol for replication
			http2 = env.get(server_prefix + '_http2') ?? !is_operations_server;
			// If we are in secure mode, we use HTTP/2 (createSecureServer from http2), with back-compat support
			// HTTP/1. We do not use HTTP/2 for insecure mode for a few reasons: browsers do not support insecure
			// HTTP/2. We have seen slower performance with HTTP/2, when used for directly benchmarking. We have
			// also seen problems with insecure HTTP/2 clients negotiating properly (Java HttpClient).
			// TODO: Add an option to not accept the root certificates, and only use the CA
			Object.assign(options, {
				allowHTTP1: true,
				rejectUnauthorized: Boolean(mtls_required),
				requestCert: Boolean(mtls || is_mtls),
				ticketKeys: getTicketKeys(),
				SNICallback: createTLSSelector(is_operations_server ? 'operations-api' : 'server', mtls),
				ALPNCallback: http2
					? undefined
					: function (connection) {
							// we use this as an indicator that the connection is a replication connection and that
							// we should use the full set of replication CAs. Loading all of them for each connection
							// is expensive
							if (connection.protocols.includes('harperdb-replication')) this.isReplicationConnection = true;
							return 'http/1.1';
						},
				ALPNProtocols: null,
			});
		}
		let license_warning = checkMemoryLimit();
		let server = (http_servers[port] = (secure ? (http2 ? createSecureServer : createSecureServerHttp1) : createServer)(
			options,
			async (node_request, node_response) => {
				try {
					let start_time = performance.now();
					let request = new Request(node_request, node_response);
					if (is_operations_server) request.isOperationsServer = true;
					// assign a more WHATWG compliant headers object, this is our real standard interface
					let response = await http_chain[port](request);
					if (!response) {
						// this means that the request was completely handled, presumably through the
						// node_response and we are actually just done
						if (request._nodeResponse.statusCode) return;
						response = unhandled(request);
					}
					if (!response.headers?.set) {
						response.headers = new Headers(response.headers);
					}
					if (license_warning)
						response.headers?.set?.(
							'Server',
							'Unlicensed HarperDB, this should only be used for educational and development purposes'
						);
					else response.headers?.set?.('Server', 'HarperDB');

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
					let body = response.body;
					let sent_body;
					if (!response.handlesHeaders) {
						const headers = response.headers || new Headers();
						if (!body) {
							headers.set('Content-Length', '0');
							sent_body = true;
						} else if (body.length >= 0) {
							if (typeof body === 'string') headers.set('Content-Length', Buffer.byteLength(body));
							else headers.set('Content-Length', body.length);
							sent_body = true;
						}
						let server_timing = `hdb;dur=${execution_time.toFixed(2)}`;
						if (response.wasCacheMiss) {
							server_timing += ', miss';
						}
						appendHeader(headers, 'Server-Timing', server_timing, true);
						if (!node_response.headersSent)
							node_response.writeHead(status, headers && (headers[Symbol.iterator] ? Array.from(headers) : headers));
						if (sent_body) node_response.end(body);
					}
					const handler_path = request.handlerPath;
					const method = request.method;
					recordAction(
						execution_time,
						'duration',
						handler_path,
						method,
						response.wasCacheMiss == undefined ? undefined : response.wasCacheMiss ? 'cache-miss' : 'cache-hit'
					);
					recordActionBinary(status < 400, 'success', handler_path, method);
					recordActionBinary(1, 'response_' + status, handler_path, method);
					if (!sent_body) {
						if (body instanceof ReadableStream) body = Readable.fromWeb(body);
						if (body[Symbol.iterator] || body[Symbol.asyncIterator]) body = Readable.from(body);

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
					}
				} catch (error) {
					onError(error);
				}
				function onError(error) {
					const headers = error.headers;
					node_response.writeHead(
						error.statusCode || 500,
						headers && (headers[Symbol.iterator] ? Array.from(headers) : headers)
					);
					node_response.end(error.toString());
					// a status code is interpreted as an expected error, so just info or warn, otherwise log as error
					if (error.statusCode) {
						if (error.statusCode === 500) harper_logger.warn(error);
						else harper_logger.info(error);
					} else harper_logger.error(error);
				}
			}
		));

		// Node v16 and earlier required setting this as a property; but carefully, we must only set if it is actually a
		// number or it will actually crash the server
		if (keepAliveTimeout >= 0) server.keepAliveTimeout = keepAliveTimeout;
		if (headersTimeout >= 0) server.headersTimeout = headersTimeout;

		/* Should we use HTTP2 on upgrade?:
		http_servers[port].on('upgrade', function upgrade(request, socket, head) {
			wss.handleUpgrade(request, socket, head, function done(ws) {
				wss.emit('connection', ws, request);
			});
		});*/
		if (secure) {
			if (!server.ports) server.ports = [];
			server.ports.push(port);
			options.SNICallback.initialize(server);
			if (mtls) server.mtlsConfig = mtls;
			server.on('secureConnection', (socket) => {
				if (socket._parent.startTime) recordAction(performance.now() - socket._parent.startTime, 'tls-handshake', port);
				recordAction(socket.isSessionReused(), 'tls-reused', port);
			});
			server.isSecure = true;
		}
		registerServer(server, port);
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
		request._nodeRequest.user = request.user;
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
	let socket_server;
	if (options.securePort) {
		setPortServerMap(options.securePort, { protocol_name: 'TLS', name: getComponentName() });
		let SNICallback = createTLSSelector('server', options.mtls);
		socket_server = createSecureSocketServer(
			{
				rejectUnauthorized: Boolean(options.mtls?.required),
				requestCert: Boolean(options.mtls),
				noDelay: true, // don't delay for Nagle's algorithm, it is a relic of the past that slows things down: https://brooker.co.za/blog/2024/05/09/nagle.html
				keepAlive: true,
				keepAliveInitialDelay: 600, // 10 minute keep-alive, want to be proactive about closing unused connections
				SNICallback,
			},
			listener
		);
		SNICallback.initialize(socket_server);
		SERVERS[options.securePort] = socket_server;
	}
	if (options.port) {
		setPortServerMap(options.port, { protocol_name: 'TCP', name: getComponentName() });
		socket_server = createSocketServer(listener, {
			noDelay: true,
			keepAlive: true,
			keepAliveInitialDelay: 600,
		});
		SERVERS[options.port] = socket_server;
	}
	return socket_server;
}
// workaround for inability to defer upgrade from https://github.com/nodejs/node/issues/6339#issuecomment-570511836
Object.defineProperty(IncomingMessage.prototype, 'upgrade', {
	get() {
		return (
			'connection' in this.headers &&
			'upgrade' in this.headers &&
			this.headers.connection.includes('Upgrade') &&
			this.headers.upgrade.toLowerCase() == 'websocket'
		);
	},
	set(v) {},
});
function onWebSocket(listener, options) {
	let servers = [];
	for (let { port: port_num, secure } of getPorts(options)) {
		setPortServerMap(port_num, {
			protocol_name: secure ? 'WSS' : 'WS',
			name: getComponentName(),
		});
		if (!ws_servers[port_num]) {
			let http_server;
			ws_servers[port_num] = new WebSocketServer({
				server: (http_server = getHTTPServer(port_num, secure, options?.isOperationsServer, options?.mtls)),
				maxPayload: options.maxPayload ?? 100 * 1024 * 1024, // The ws library has a default of 100MB
			});
			http_server._ws = ws_servers[port_num];
			servers.push(http_server);
			ws_servers[port_num].on('connection', async (ws, node_request) => {
				try {
					let request = new Request(node_request);
					request.isWebSocket = true;
					let chain_completion = http_chain[port_num](request);
					let protocol = node_request.headers['sec-websocket-protocol'];
					let ws_listeners_for_port = ws_listeners[port_num];
					let found_handler;
					if (protocol) {
						// first we try to match on WS handlers that match the specified protocol
						for (let i = 0; i < ws_listeners_for_port.length; i++) {
							let handler = ws_listeners_for_port[i];
							if (handler.protocol === protocol) {
								// if we have a handler for a specific protocol, allow it to select on that protocol
								// to the exclusion of other handlers
								found_handler = true;
								handler.listener(ws, request, chain_completion);
							}
						}
						if (found_handler) return;
					}
					// now let generic WS handlers handle the connection
					for (let i = 0; i < ws_listeners_for_port.length; i++) {
						let handler = ws_listeners_for_port[i];
						if (!handler.protocol) {
							// generic handlers don't have a protocol
							handler.listener(ws, request, chain_completion);
							found_handler = true;
						}
					}
					if (!found_handler) {
						// if we have no handlers, we close the connection
						ws.close(1008, 'No handler for protocol');
					}
				} catch (error) {
					harper_logger.warn('Error handling WebSocket connection', error);
				}
			});

			ws_servers[port_num].on('error', (error) => {
				console.log('Error in setting up WebSocket server', error);
			});
		}
		let protocol = options?.subProtocol || '';
		let ws_listeners_for_port = ws_listeners[port_num];
		if (!ws_listeners_for_port) ws_listeners_for_port = ws_listeners[port_num] = [];
		ws_listeners_for_port.push({ listener, protocol });
		http_chain[port_num] = makeCallbackChain(http_responders, port_num);
	}
	return servers;
}
function defaultNotFound(request, response) {
	response.writeHead(404);
	response.end('Not found\n');
}
