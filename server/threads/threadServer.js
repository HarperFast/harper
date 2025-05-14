'use strict';
require('../../bin/dev.js');
const { isMainThread, parentPort, threadId, workerData } = require('node:worker_threads');
const { Socket, createServer: createSocketServer } = require('node:net');
const { createServer, IncomingMessage } = require('node:http');
const { createServer: createSecureServerHttp1 } = require('node:https');
const { createSecureServer } = require('node:http2');
const { Blob } = require('../../resources/blob.ts');
const { unlinkSync, existsSync } = require('fs');
const harperLogger = require('../../utility/logging/harper_logger.js');
const env = require('../../utility/environment/environmentManager.js');
const terms = require('../../utility/hdbTerms.ts');
const { server } = require('../Server.ts');
const { WebSocketServer } = require('ws');
let { createServer: createSecureSocketServer } = require('node:tls');
const { getTicketKeys, restartNumber, getWorkerIndex } = require('./manageThreads.js');
const { Headers, appendHeader } = require('../serverHelpers/Headers.ts');
const { recordAction, recordActionBinary } = require('../../resources/analytics/write.ts');
const { Request, createReuseportFd } = require('../serverHelpers/Request.ts');
const { checkMemoryLimit } = require('../../utility/registration/hdb_license.js');
const { createTLSSelector } = require('../../security/keys.js');
const { resolvePath } = require('../../config/configUtils.js');
const { startupLog } = require('../../bin/run.js');
const { Readable } = require('node:stream');
const globals = require('../../globals.js');

const debugThreads = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG);
if (debugThreads) {
	let port;
	if (isMainThread) {
		port = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG_PORT) ?? 9229;
		process.on(['SIGINT', 'SIGTERM', 'SIGQUIT', 'exit'], () => {
			try {
				require('inspector').close();
			} catch (error) {
				harperLogger.info('Could not close debugger', error);
			}
		});
	} else {
		const startingPort = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG_STARTINGPORT);
		if (startingPort && getWorkerIndex() >= 0) {
			port = startingPort + getWorkerIndex();
		}
	}
	if (port) {
		const host = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG_HOST);
		const waitForDebugger = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG_WAITFORDEBUGGER);
		try {
			require('inspector').open(port, host, waitForDebugger);
		} catch (error) {
			harperLogger.trace(`Could not start debugging on port ${port}, you may already be debugging:`, error.message);
		}
	}
} else if (process.env.DEV_MODE && isMainThread) {
	try {
		require('inspector').open(9229);
	} catch (error) {
		if (restartNumber <= 1)
			harperLogger.trace('Could not start debugging on port 9229, you may already be debugging:', error.message);
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
const sessionAffinity = env.get(CONFIG_PARAMS.HTTP_SESSIONAFFINITY);
const SERVERS = {};
const portServer = new Map();
exports.registerServer = registerServer;
exports.httpServer = httpServer;
exports.deliverSocket = deliverSocket;
exports.startServers = startServers;
exports.listenOnPorts = listenOnPorts;
exports.globals = globals;
exports.whenComponentsLoaded = null;
server.http = httpServer;
server.request = onRequest;
server.socket = onSocket;
server.ws = onWebSocket;
server.upgrade = onUpgrade;
const websocketServers = {};
let httpServers = {},
	httpChain = {},
	httpResponders = [];

function startServers() {
	return (exports.whenComponentsLoaded = require('../loadRootComponents.js')
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
						harperLogger.trace('received shutdown request', threadId);
						// shutdown (for these threads) means stop listening for incoming requests (finish what we are working) and
						// close connections as possible, then let the event loop complete
						for (let port in SERVERS) {
							const server = SERVERS[port];
							let closeAllTimer;
							if (server.closeIdleConnections) {
								// Here we attempt to gracefully close all outstanding keep-alive connections,
								// repeatedly closing any connections that are idle. This allows any active requests
								// to finish sending their response, then we close their connections.
								let symbols = Object.getOwnPropertySymbols(server);
								let connectionsSymbol = symbols.find((symbol) => symbol.description.includes('connections'));
								let closeAttempts = 0;
								let timer = setInterval(() => {
									closeAttempts++;
									const forceClose = closeAttempts >= 100;
									let connections = server[connectionsSymbol][forceClose ? 'all' : 'idle']();
									if (connections.length === 0) {
										if (forceClose) clearInterval(timer);
										return;
									}
									if (closeAttempts === 1) harperLogger.info(`Closing ${connections.length} idle connections`);
									else if (forceClose)
										harperLogger.warn(`Forcefully closing ${connections.length} active connections`);
									for (let i = 0, l = connections.length; i < l; i++) {
										const socket = connections[i].socket;
										if (socket._httpMessage && !socket._httpMessage.finished && !forceClose) {
											continue;
										}
										if (forceClose) socket.destroySoon();
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

								clearInterval(closeAllTimer);
								// We hope for a graceful exit once all connections have been closed, and no
								// more incoming connections are accepted, but if we need to, we eventually will exit
								setTimeout(() => {
									console.log('forced close server', port, threadId);
									if (!server.cantCleanupProperly) harperLogger.warn('Had to forcefully exit the thread', threadId);
									process.exit(0);
								}, 5000).unref();
							});
						}
						if (debugThreads || process.env.DEV_MODE) {
							try {
								require('inspector').close();
							} catch (error) {
								harperLogger.info('Could not close debugger', error);
							}
						}
					}
				})
				.ref(); // use this to keep the thread running until we are ready to shutdown and clean up handles
			let listening;
			if (createReuseportFd && !sessionAffinity) {
				listening = listenOnPorts();
			}

			// notify that we are now ready to start receiving requests
			Promise.resolve(listening).then(() => {
				if (getWorkerIndex() === 0) {
					try {
						startupLog(portServer);
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
							harperLogger.info('Domain socket listening on ' + port);
						})
						.on('error', reject);
				})
			);
			continue;
		}
		let listen_on;
		const threadRange = env.get(terms.CONFIG_PARAMS.HTTP_THREADRANGE);
		if (threadRange) {
			let threadRangeArray = typeof threadRange === 'string' ? threadRange.split('-') : threadRange;
			let threadIndex = getWorkerIndex();
			if (threadIndex < threadRangeArray[0] || threadIndex > threadRangeArray[1]) {
				continue;
			}
		}

		let fd;
		try {
			const lastColon = port.lastIndexOf(':');
			if (lastColon > 0)
				if (createReuseportFd)
					// if there is a colon, we assume it is a host:port pair, and then strip brackets as that is a common way to
					// specify an IPv6 address
					listen_on = {
						fd: createReuseportFd(+port.slice(lastColon + 1).replace(/[\[\]]/g, ''), port.slice(0, lastColon)),
					};
				else listen_on = { host: +port.slice(lastColon + 1).replace(/[\[\]]/g, ''), port: port.slice(0, lastColon) };
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
						harperLogger.trace('Listening on port ' + port, threadId);
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

function deliverSocket(fdOrSocket, port, data) {
	// Create a socket and deliver it to the HTTP server
	// HTTP server likes to allow half open sockets
	let socket = fdOrSocket?.read
		? fdOrSocket
		: new Socket({ fd: fdOrSocket, readable: true, writable: true, allowHalfOpen: true });
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
					harperLogger.error(`Server on port ${port} was not registered`);
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
const { getComponentName } = require('../../components/componentLoader.ts');

function registerServer(server, port, checkPort = true) {
	if (!port) {
		// if no port is provided, default to custom functions port
		port = env.get(terms.CONFIG_PARAMS.HTTP_PORT);
	}
	let existingServer = SERVERS[port];
	if (existingServer) {
		// if there is an existing server on this port, we create a cascading delegation to try the request with one
		// server and if doesn't handle the request, cascade to next server (until finally we 404)
		let lastServer = existingServer.lastServer || existingServer;
		if (lastServer === server) throw new Error(`Can not register the same server twice for the same port ${port}`);
		if (checkPort && Boolean(lastServer.sessionIdContext) !== Boolean(server.sessionIdContext) && +port)
			throw new Error(`Can not mix secure HTTPS and insecure HTTP on the same port ${port}`);
		lastServer.off('unhandled', defaultNotFound);
		lastServer.on('unhandled', (request, response) => {
			// fastify can't clean up properly, and as soon as we have received a fastify request, must mark our mode
			// as such
			if (server.cantCleanupProperly) existingServer.cantCleanupProperly = true;
			server.emit('request', request, response);
		});
		existingServer.lastServer = server;
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
			httpResponders[options?.runFirst ? 'unshift' : 'push']({ listener, port: options?.port || port });
		} else {
			listener.isSecure = secure;
			registerServer(listener, port, false);
		}
		httpChain[port] = makeCallbackChain(httpResponders, port);
	}

	return servers;
}

function setPortServerMap(port, server) {
	const portEntry = portServer.get(port) ?? [];
	portServer.set(port, [...portEntry, server]);
}

function getHTTPServer(port, secure, isOperationsServer, isMtls) {
	setPortServerMap(port, { protocol_name: secure ? 'HTTPS' : 'HTTP', name: getComponentName() });
	if (!httpServers[port]) {
		let serverPrefix = isOperationsServer ? 'operationsApi_network' : 'http';
		let keepAliveTimeout = env.get(serverPrefix + '_keepAliveTimeout');
		let requestTimeout = env.get(serverPrefix + '_timeout');
		let headersTimeout = env.get(serverPrefix + '_headersTimeout');
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
		let mtls = env.get(serverPrefix + '_mtls');
		let mtlsRequired = env.get(serverPrefix + '_mtls_required');
		let http2;

		if (secure) {
			// check if we want to enable HTTP/2; operations server doesn't use HTTP/2 because it doesn't allow the
			// ALPNCallback to work with our custom protocol for replication
			http2 = env.get(serverPrefix + '_http2');
			// If we are in secure mode, we use HTTP/2 (createSecureServer from http2), with back-compat support
			// HTTP/1. We do not use HTTP/2 for insecure mode for a few reasons: browsers do not support insecure
			// HTTP/2. We have seen slower performance with HTTP/2, when used for directly benchmarking. We have
			// also seen problems with insecure HTTP/2 clients negotiating properly (Java HttpClient).
			// TODO: Add an option to not accept the root certificates, and only use the CA
			Object.assign(options, {
				allowHTTP1: true,
				rejectUnauthorized: Boolean(mtlsRequired),
				requestCert: Boolean(mtls || isMtls),
				ticketKeys: getTicketKeys(),
				SNICallback: createTLSSelector(isOperationsServer ? 'operations-api' : 'server', mtls),
			});
		}
		let licenseWarning = checkMemoryLimit();
		let server = (httpServers[port] = (secure ? (http2 ? createSecureServer : createSecureServerHttp1) : createServer)(
			options,
			async (nodeRequest, nodeResponse) => {
				try {
					let startTime = performance.now();
					let request = new Request(nodeRequest, nodeResponse);
					if (isOperationsServer) request.isOperationsServer = true;
					// assign a more WHATWG compliant headers object, this is our real standard interface
					let response = await httpChain[port](request);
					if (!response) {
						// this means that the request was completely handled, presumably through the
						// nodeResponse and we are actually just done
						if (request._nodeResponse.statusCode) return;
						response = unhandled(request);
					}
					if (!response.headers?.set) {
						response.headers = new Headers(response.headers);
					}
					if (licenseWarning)
						response.headers?.set?.(
							'Server',
							'Unlicensed HarperDB, this should only be used for educational and development purposes'
						);
					else response.headers?.set?.('Server', 'HarperDB');

					if (response.status === -1) {
						// This means the HDB stack didn't handle the request, and we can then cascade the request
						// to the server-level handler, forming the bridge to the slower legacy fastify framework that expects
						// to interact with a node HTTP server object.
						for (let headerPair of response.headers || []) {
							nodeResponse.setHeader(headerPair[0], headerPair[1]);
						}
						nodeRequest.baseRequest = request;
						nodeResponse.baseResponse = response;
						return httpServers[port].emit('unhandled', nodeRequest, nodeResponse);
					}
					const status = response.status || 200;
					const endTime = performance.now();
					const executionTime = endTime - startTime;
					let body = response.body;
					let sentBody;
					let deferWriteHead = false;
					if (!response.handlesHeaders) {
						const headers = response.headers || new Headers();
						if (!body) {
							headers.set('Content-Length', '0');
							sentBody = true;
						} else if (body.length >= 0) {
							if (typeof body === 'string') headers.set('Content-Length', Buffer.byteLength(body));
							else headers.set('Content-Length', body.length);
							sentBody = true;
						} else if (body instanceof Blob) {
							// if the size is available now, immediately set it
							if (body.size) headers.set('Content-Length', body.size);
							else if (body.on) {
								deferWriteHead = true;
								body.on('size', (size) => {
									// we can also try to set the Content-Length once the header is read and
									// the size available. but if writeHead is called, this will have no effect. So we
									// need to defer writeHead if we are going to set this
									if (!nodeResponse.headersSent) nodeResponse.setHeader('Content-Length', size);
								});
							}
							body = body.stream();
						}
						let serverTiming = `hdb;dur=${executionTime.toFixed(2)}`;
						if (response.wasCacheMiss) {
							serverTiming += ', miss';
						}
						appendHeader(headers, 'Server-Timing', serverTiming, true);
						if (!nodeResponse.headersSent) {
							if (deferWriteHead) {
								// if we are deferring, we need to set the statusCode and headers, let any other headers be set later
								// until the first write
								nodeResponse.statusCode = status;
								if (headers) {
									if (headers[Symbol.iterator]) {
										for (let [name, value] of headers) {
											nodeResponse.setHeader(name, value);
										}
									} else {
										for (let name in headers) {
											nodeResponse.setHeader(name, headers[name]);
										}
									}
								}
							} // else the fast path, if we don't have to defer
							else
								nodeResponse.writeHead(status, headers && (headers[Symbol.iterator] ? Array.from(headers) : headers));
						}
						if (sentBody) nodeResponse.end(body);
					}
					const handlerPath = request.handlerPath;
					const method = request.method;
					recordAction(
						executionTime,
						'duration',
						handlerPath,
						method,
						response.wasCacheMiss == undefined ? undefined : response.wasCacheMiss ? 'cache-miss' : 'cache-hit'
					);
					recordActionBinary(status < 400, 'success', handlerPath, method);
					recordActionBinary(1, 'response_' + status, handlerPath, method);
					if (!sentBody) {
						if (body instanceof ReadableStream) body = Readable.fromWeb(body);
						if (body[Symbol.iterator] || body[Symbol.asyncIterator]) body = Readable.from(body);

						// if it is a stream, pipe it
						if (body?.pipe) {
							body.pipe(nodeResponse);
							if (body.destroy)
								nodeResponse.on('close', () => {
									body.destroy();
								});
							let bytesSent = 0;
							body.on('data', (data) => {
								bytesSent += data.length;
							});
							body.on('end', () => {
								recordAction(performance.now() - endTime, 'transfer', handlerPath, method);
								recordAction(bytesSent, 'bytes-sent', handlerPath, method);
							});
						}
						// else just send the buffer/string
						else if (body?.then)
							body.then((body) => {
								nodeResponse.end(body);
							}, onError);
						else nodeResponse.end(body);
					}
				} catch (error) {
					onError(error);
				}
				function onError(error) {
					const headers = error.headers;
					nodeResponse.writeHead(
						error.statusCode || 500,
						headers && (headers[Symbol.iterator] ? Array.from(headers) : headers)
					);
					nodeResponse.end(error.toString());
					// a status code is interpreted as an expected error, so just info or warn, otherwise log as error
					if (error.statusCode) {
						if (error.statusCode === 500) harperLogger.warn(error);
						else harperLogger.info(error);
					} else harperLogger.error(error);
				}
			}
		));

		// Node v16 and earlier required setting this as a property; but carefully, we must only set if it is actually a
		// number or it will actually crash the server
		if (keepAliveTimeout >= 0) server.keepAliveTimeout = keepAliveTimeout;
		if (headersTimeout >= 0) server.headersTimeout = headersTimeout;

		/* Should we use HTTP2 on upgrade?:
		httpServers[port].on('upgrade', function upgrade(request, socket, head) {
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
	return httpServers[port];
}

function makeCallbackChain(responders, portNum) {
	let nextCallback = unhandled;
	// go through the listeners in reverse order so each callback can be passed to the one before
	// and then each middleware layer can call the next middleware layer
	for (let i = responders.length; i > 0; ) {
		let { listener, port } = responders[--i];
		if (port === portNum || port === 'all') {
			let callback = nextCallback;
			nextCallback = (...args) => {
				// for listener only layers, the response through
				return listener(...args, callback);
			};
		}
	}
	return nextCallback;
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
	let socketServer;
	if (options.securePort) {
		setPortServerMap(options.securePort, { protocol_name: 'TLS', name: getComponentName() });
		let SNICallback = createTLSSelector('server', options.mtls);
		socketServer = createSecureSocketServer(
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
		SNICallback.initialize(socketServer);
		SERVERS[options.securePort] = socketServer;
	}
	if (options.port) {
		setPortServerMap(options.port, { protocol_name: 'TCP', name: getComponentName() });
		socketServer = createSocketServer(listener, {
			noDelay: true,
			keepAlive: true,
			keepAliveInitialDelay: 600,
		});
		SERVERS[options.port] = socketServer;
	}
	return socketServer;
}
// workaround for inability to defer upgrade from https://github.com/nodejs/node/issues/6339#issuecomment-570511836
Object.defineProperty(IncomingMessage.prototype, 'upgrade', {
	get() {
		return (
			'connection' in this.headers &&
			'upgrade' in this.headers &&
			this.headers.connection.toLowerCase().includes('upgrade') &&
			this.headers.upgrade.toLowerCase() == 'websocket'
		);
	},
	set(v) {},
});

/**
 * @typedef {Object} OnUpgradeOptions
 * @property {number=} port
 * @property {number=} securePort
 */

/**
 * @typedef {(request: unknown, next: Listener) => void | Promise<void>} Listener
 */

let upgradeListeners = [],
	upgradeChains = {};

/**
 *
 * @param {Listener} listener
 * @param {OnUpgradeOptions} options
 * @returns
 */
function onUpgrade(listener, options) {
	for (const { port } of getPorts(options)) {
		upgradeListeners[options?.runFirst ? 'unshift' : 'push']({ listener, port });
		upgradeChains[port] = makeCallbackChain(upgradeListeners, port);
	}
}

/**
 * @typedef {Object} OnWebSocketOptions
 * @property {number=} port
 * @property {number=} securePort
 * @property {number=} maxPayload - The maximum size of a message that can be received. Defaults to 100MB
 */

let websocketListeners = [],
	websocketChains = {};
/**
 *
 * @param {Listener} listener
 * @param {OnWebSocketOptions} options
 * @returns
 */
function onWebSocket(listener, options) {
	const servers = [];

	for (let { port, secure } of getPorts(options)) {
		setPortServerMap(port, {
			protocol_name: secure ? 'WSS' : 'WS',
			name: getComponentName(),
		});

		const server = getHTTPServer(port, secure, options?.isOperationsServer, options?.mtls);

		if (!websocketServers[port]) {
			websocketServers[port] = new WebSocketServer({
				noServer: true,
				// TODO: this should be a global config and not per ws listener
				maxPayload: options.maxPayload ?? 100 * 1024 * 1024, // The ws library has a default of 100MB
			});

			websocketServers[port].on('connection', (ws, incomingMessage) => {
				const request = new Request(incomingMessage);
				request.isWebSocket = true;
				const chainCompletion = httpChain[port](request);
				websocketChains[port](ws, request, chainCompletion);
			});

			// Add the default upgrade handler if it doesn't exist.
			onUpgrade(
				(request, socket, head, next) => {
					// If the request has already been upgraded, continue without upgrading
					if (request.__harperdbRequestUpgraded) {
						return next(request, socket, head);
					}

					// Otherwise, upgrade the socket and then continue
					return websocketServers[port].handleUpgrade(request, socket, head, (ws) => {
						request.__harperdbRequestUpgraded = true;
						next(request, socket, head);
						websocketServers[port].emit('connection', ws, request);
					});
				},
				{ port }
			);

			// Call the upgrade middleware chain
			server.on('upgrade', (request, socket, head) => {
				if (upgradeChains[port]) {
					upgradeChains[port](request, socket, head);
				}
			});
		}

		servers.push(server);

		websocketListeners[options?.runFirst ? 'unshift' : 'push']({ listener, port });
		websocketChains[port] = makeCallbackChain(websocketListeners, port);

		// mqtt doesn't invoke the http handler so this needs to be here to load up the http chains.
		httpChain[port] = makeCallbackChain(httpResponders, port);
	}

	return servers;
}

function defaultNotFound(request, response) {
	response.writeHead(404);
	response.end('Not found\n');
}
