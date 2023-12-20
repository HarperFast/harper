'use strict';
const { isMainThread, parentPort, threadId } = require('worker_threads');
const { Socket, createServer: createSocketServer } = require('net');
const { createServer, IncomingMessage } = require('http');
const { createServer: createSecureServer } = require('https');
const { readFileSync, unlinkSync, existsSync } = require('fs');
const harper_logger = require('../../utility/logging/harper_logger');
const env = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
const { server } = require('../Server');
const { WebSocketServer } = require('ws');
const { createServer: createSecureSocketServer } = require('tls');
const { getTicketKeys, restartNumber, getWorkerIndex } = require('./manageThreads');
const { Headers } = require('../serverHelpers/Headers');
const { recordAction, recordActionBinary } = require('../../resources/analytics');
const { Request, createReuseportFd } = require('../serverHelpers/Request');
const { checkMemoryLimit } = require('../../utility/registration/hdb_license');

// this horifying hack is brought to you by https://github.com/nodejs/node/issues/36655
const tls = require('tls');

const origCreateSecureContext = tls.createSecureContext;
tls.createSecureContext = function(options) {
	if (!options.cert || !options.key) {
		return origCreateSecureContext(options);
	}

	let lessOptions = { ...options };
	delete lessOptions.key;
	delete lessOptions.cert;
	let ctx = origCreateSecureContext(lessOptions);
	ctx.context.setCert(options.cert);
	ctx.context.setKey(options.key, undefined);
	return ctx;
};


if (process.env.DEV_MODE) {
	try {
		require('inspector').open(9229);
	} catch (error) {
		if (restartNumber <= 1)
			harper_logger.trace('Could not start debugging on port 9229, you may already be debugging:', error.message);
	}
}
process.on('uncaughtException', (error) => {
	if (error.code === 'ECONNRESET') return; // that's what network connections do
	if (error.message === 'write EIO') return; // that means the terminal is closed
	console.error('uncaughtException', error);
});
const { HDB_SETTINGS_NAMES, CONFIG_PARAMS } = terms;
env.initSync();
const session_affinity = env.get(CONFIG_PARAMS.HTTP_SESSIONAFFINITY);
const SERVERS = {};
exports.registerServer = registerServer;
exports.httpServer = httpServer;
exports.deliverSocket = deliverSocket;
exports.startServers = startServers;
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

function startServers() {
	return require('../loadRootComponents')
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
								setInterval(() => {
									server.closeIdleConnections();
								}, 25).unref();
								setTimeout(() => {
									server.closeAllConnections();
									harper_logger.info('Closed all http connections', port, threadId);
								}, 4000).unref();
							}
							// And we tell the server not to accept any more incoming connections
							server.close?.(() => {
								if (env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET) && getWorkerIndex() == 0) {
									try {
										unlinkSync(env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET));
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
						if (process.env.DEV_MODE) {
							try {
								require('inspector').close();
							} catch (error) {
								console.error('Could not close debugger', error);
							}
						}
					}
				})
				.ref(); // use this to keep the thread running until we are ready to shutdown and clean up handles
			const listening = [];
			if (createReuseportFd && !session_affinity) {
				for (let port in SERVERS) {
					const server = SERVERS[port];

					// If server is unix domain socket
					if (isNaN(port) && getWorkerIndex() == 0) {
						if (existsSync(port)) unlinkSync(port);
						listening.push(
							new Promise((resolve, reject) => {
								server
									.listen({ path: port }, () => {
										resolve();
										harper_logger.info('Domain socket listening on ' + port);
									})
									.on('error', reject);
							})
						);
						continue;
					}

					let fd;
					try {
						fd = createReuseportFd(+port, '::');
					} catch (error) {
						console.error(`Unable to bind to port ${port}`, error);
						continue;
					}
					listening.push(
						new Promise((resolve, reject) => {
							server
								.listen({ fd }, () => {
									resolve();
									harper_logger.trace('Listening on port ' + port, threadId);
								})
								.on('error', reject);
						})
					);
				}
			}

			// notify that we are now ready to start receiving requests
			Promise.all(listening).then(() => {
				parentPort?.postMessage({ type: terms.ITC_EVENT_TYPES.CHILD_STARTED });
			});
		});
}
if (!isMainThread) {
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

function registerServer(server, port) {
	if (!+port && port !== env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET)) {
		// if no port is provided, default to custom functions port
		port = parseInt(env.get(terms.CONFIG_PARAMS.HTTP_PORT), 10);
	}
	let existing_server = SERVERS[port];
	if (existing_server) {
		// if there is an existing server on this port, we create a cascading delegation to try the request with one
		// server and if doesn't handle the request, cascade to next server (until finally we 404)
		let last_server = existing_server.lastServer || existing_server;
		if (last_server === server) throw new Error(`Can not register the same server twice for the same port ${port}`);
		if (Boolean(last_server.sessionIdContext) !== Boolean(server.sessionIdContext) && +port)
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
	let port_num = parseInt(options?.securePort);
	if (port_num) ports.push({ port: port_num, secure: true });
	port_num = parseInt(options?.port);
	if (port_num) ports.push({ port: port_num, secure: false });
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
		ports.push({ port: env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET), secure: false });
	}
	return ports;
}
function httpServer(listener, options) {
	for (let { port, secure } of getPorts(options)) {
		getHTTPServer(port, secure, options?.isOperationsServer);
		if (typeof listener === 'function') {
			http_responders[options?.runFirst ? 'unshift' : 'push']({ listener, port: options?.port || port });
		} else {
			listener.isSecure = secure;
			registerServer(listener, port);
		}
		http_chain[port] = makeCallbackChain(http_responders, port);
		ws_chain = makeCallbackChain(request_listeners, port);
	}
}
function getHTTPServer(port, secure, is_operations_server) {
	if (!http_servers[port]) {
		let server_prefix = is_operations_server ? 'operationsApi_network' : 'http';
		let options = {
			keepAliveTimeout: env.get(server_prefix + '_keepAliveTimeout'),
			headersTimeout: env.get(server_prefix + '_headersTimeout'),
			requestTimeout: env.get(server_prefix + '_timeout'),
		};
		let mtls = env.get(server_prefix + '_mtls');
		if (secure) {
			server_prefix = is_operations_server ? 'operationsApi_' : '';
			const private_key = env.get(server_prefix + 'tls_privateKey');
			const certificate = env.get(server_prefix + 'tls_certificate');
			const certificate_authority = env.get(server_prefix + 'tls_certificateAuthority');
			// If we are in secure mode, we use HTTP/2 (createSecureServer from http2), with back-compat support
			// HTTP/1. We do not use HTTP/2 for insecure mode for a few reasons: browsers do not support insecure
			// HTTP/2. We have seen slower performance with HTTP/2, when used for directly benchmarking. We have
			// also seen problems with insecure HTTP/2 clients negotiating properly (Java HttpClient).
			Object.assign(options, {
				allowHTTP1: true,
				key: readFileSync(private_key),
				ciphers: env.get('tls_ciphers'),
				cert: readFileSync(certificate),
				ca: certificate_authority && readFileSync(certificate_authority),
				requestCert: Boolean(mtls),
				ticketKeys: getTicketKeys(),
			});
		}
		let license_warning = checkMemoryLimit();
		http_servers[port] = (secure ? createSecureServer : createServer)(options, async (node_request, node_response) => {
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
					if (headers.append) {
						let server_timing = `hdb;dur=${execution_time.toFixed(2)}`;
						if (response.wasCacheMiss) {
							server_timing += ', miss';
						}
						headers.append('Server-Timing', server_timing, true);
					}
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
				if (!sent_body) {
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
		});
		/* Should we use HTTP2 on upgrade?:
		http_servers[port].on('upgrade', function upgrade(request, socket, head) {
			wss.handleUpgrade(request, socket, head, function done(ws) {
				wss.emit('connection', ws, request);
			});
		});*/
		if (secure) {
			http_servers[port].on('secureConnection', (socket) => {
				if (socket._parent.startTime) recordAction(performance.now() - socket._parent.startTime, 'tls-handshake', port);
				recordAction(socket.isSessionReused(), 'tls-reused', port);
			});
			http_servers[port].isSecure = true;
		}
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
		const private_key_path = env.get('tls_privateKey');
		const certificate_path = env.get('tls_certificate');
		const certificate_authority_path = options.mtls?.certificateAuthority || env.get('tls_certificateAuthority');

		socket_server = createSecureSocketServer(
			{
				ciphers: env.get('tls_ciphers'),
				key: readFileSync(private_key_path),
				// if they have a CA, we append it, so it is included
				cert: readFileSync(certificate_path),
				ca: certificate_authority_path && readFileSync(certificate_authority_path),
				requestCert: Boolean(options.mtls),
			},
			listener
		);
		SERVERS[options.securePort] = socket_server;
	}
	if (options.port) {
		socket_server = createSocketServer(listener);
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
				try {
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
				} catch (error) {
					harper_logger.warn('Error handling WebSocket connection', error);
				}
			});

			ws_servers[port_num].on('error', (error) => {
				console.log('Error in setting up WebSocket server', error);
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
