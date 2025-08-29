/**
 * This module represents the HTTP component for Harper, and receives the HTTP options and uses them to configure
 * HTTP servers
 */
import { Scope } from '../components/Scope.ts';
import { Socket } from 'node:net';
import harperLogger from '../utility/logging/harper_logger.js';
import { parentPort } from 'node:worker_threads';
import env from '../utility/environment/environmentManager.js';
import * as terms from '../utility/hdbTerms.ts';
import { resolvePath } from '../config/configUtils.js';
import { getTicketKeys } from './threads/manageThreads.js';
import { createTLSSelector } from '../security/keys.js';
import { createSecureServer } from 'node:http2';
import { createServer as createSecureServerHttp1 } from 'node:https';
import { createServer, IncomingMessage } from 'node:http';
import { Request } from './serverHelpers/Request.ts';
import { appendHeader, Headers } from './serverHelpers/Headers.ts';
import { Blob } from '../resources/blob.ts';
import { recordAction, recordActionBinary } from '../resources/analytics/write.ts';
import { Readable } from 'node:stream';
import { server } from './Server.ts';
import { setPortServerMap, SERVERS } from './serverRegistry.ts';
import { getComponentName } from '../components/componentLoader.ts';
import { throttle } from './throttle.ts';
import { WebSocketServer } from 'ws';
import { isLicensed } from '../resources/usageLicensing.ts';

const { errorToString } = harperLogger;
server.http = httpServer;
server.request = onRequest;
server.ws = onWebSocket;
server.upgrade = onUpgrade;
const websocketServers = {};
const httpServers = {},
	httpChain = {},
	httpResponders = [];
let httpOptions: any = {};
export const suppressHandleApplicationWarning = true;
export function handleApplication(scope: Scope) {
	httpOptions = scope.options.getAll();
	scope.options.on('change', (key) => {
		// TODO: Check to see if the key is something we can or can't handle
		httpOptions = scope.options.getAll();
	});
}
export function getHttpOptions() {
	return httpOptions;
}

export function deliverSocket(fdOrSocket, port, data) {
	// Create a socket and deliver it to the HTTP server
	// HTTP server likes to allow half open sockets
	const socket = fdOrSocket?.read
		? fdOrSocket
		: new Socket({ fd: fdOrSocket, readable: true, writable: true, allowHalfOpen: true });
	// for each socket, deliver the connection to the HTTP server handler/parser
	const server = SERVERS[port];
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
				const server = SERVERS[port];
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

const requestMap = new Map();
export function proxyRequest(message) {
	const { port, event, data, requestId } = message;
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
			const originalDestroy = socket.destroy;
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

export function registerServer(server, port, checkPort = true) {
	if (!port) {
		// if no port is provided, default to custom functions port
		port = env.get(terms.CONFIG_PARAMS.HTTP_PORT);
	}
	const existingServer = SERVERS[port];
	if (existingServer) {
		// if there is an existing server on this port, we create a cascading delegation to try the request with one
		// server and if doesn't handle the request, cascade to next server (until finally we 404)
		const lastServer = existingServer.lastServer || existingServer;
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
export function httpServer(listener, options) {
	const servers = [];

	for (const { port, secure } of getPorts(options)) {
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

function getHTTPServer(port, secure, isOperationsServer, isMtls) {
	setPortServerMap(port, { protocol_name: secure ? 'HTTPS' : 'HTTP', name: getComponentName() });
	if (!httpServers[port]) {
		// TODO: These should all come from httpOptions or operationsApiOptions
		const serverPrefix = isOperationsServer ? 'operationsApi_network' : 'http';
		const keepAliveTimeout = env.get(serverPrefix + '_keepAliveTimeout');
		const requestTimeout = env.get(serverPrefix + '_timeout');
		const headersTimeout = env.get(serverPrefix + '_headersTimeout');
		const options = {
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
		const mtls = env.get(serverPrefix + '_mtls');
		const mtlsRequired = env.get(serverPrefix + '_mtls_required');
		let http2;

		if (secure) {
			const tlsConfig = env.get('tls');
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
				ciphers: tlsConfig.ciphers ?? tlsConfig[0]?.ciphers,
			});
		}
		const requestHandler = async (nodeRequest: IncomingMessage, nodeResponse: any) => {
			const startTime = performance.now();
			let requestId = 0;
			try {
				const request = new Request(nodeRequest, nodeResponse);
				if (isOperationsServer) request.isOperationsServer = true;
				if (httpOptions.logging?.id) request.requestId = requestId = getRequestId();
				// assign a more WHATWG compliant headers object, this is our real standard interface
				let response = await httpChain[port](request);
				if (!response) {
					// this means that the request was completely handled, presumably through the
					// nodeResponse and we are actually just done
					if (request._nodeResponse.statusCode) {
						logRequest(nodeRequest, request._nodeResponse.statusCode, requestId, performance.now() - startTime);
						return;
					}
					response = unhandled(request);
				}
				if (!response.headers?.set) {
					response.headers = new Headers(response.headers);
				}
				if (await isLicensed()) {
					response.headers.set('Server', 'HarperDB');
				} else {
					response.headers.set('Server', 'Unlicensed HarperDB, this should only be used for educational and development purposes');
				}

				if (response.status === -1) {
					// This means the HDB stack didn't handle the request, and we can then cascade the request
					// to the server-level handler, forming the bridge to the slower legacy fastify framework that expects
					// to interact with a node HTTP server object.
					for (const headerPair of response.headers || []) {
						nodeResponse.setHeader(headerPair[0], headerPair[1]);
					}
					nodeRequest.baseRequest = request;
					nodeResponse.baseResponse = response;
					return httpServers[port].emit('unhandled', nodeRequest, nodeResponse);
				}
				const status = response.status || 200;
				nodeResponse.statusCode = status;
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

							if (headers) {
								if (headers[Symbol.iterator]) {
									for (const [name, value] of headers) {
										nodeResponse.setHeader(name, value);
									}
								} else {
									for (const name in headers) {
										nodeResponse.setHeader(name, headers[name]);
									}
								}
							}
						} // else the fast path, if we don't have to defer
						else nodeResponse.writeHead(status, headers && (headers[Symbol.iterator] ? Array.from(headers) : headers));
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
				logRequest(nodeRequest, status, requestId, executionTime);
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
				const status = error.statusCode || 500;
				nodeResponse.writeHead(status, headers && (headers[Symbol.iterator] ? Array.from(headers) : headers));
				nodeResponse.end(errorToString(error));
				logRequest(nodeRequest, status, requestId, performance.now() - startTime);
				// a status code is interpreted as an expected error, so just info or warn, otherwise log as error
				if (error.statusCode) {
					if (error.statusCode === 500) harperLogger.warn(error);
					else harperLogger.info(error);
				} else harperLogger.error(error);
			}
		};
		// create a throttled version of the request handler, so we can throttle POST requests
		const throttledRequestHandler = throttle(
			requestHandler,
			(nodeRequest: IncomingMessage, nodeResponse: any) => {
				// if the request queue is taking too long, we want to return an error
				nodeResponse.statusCode = 503;
				nodeResponse.end('Service unavailable, exceeded request queue limit');
				recordAction(true, 'service-unavailable', port);
			},
			env.get(serverPrefix + '_requestQueueLimit')
		);
		const server = (httpServers[port] = (
			secure ? (http2 ? createSecureServer : createSecureServerHttp1) : createServer
		)(options, (nodeRequest: IncomingMessage, nodeResponse: any) => {
			// throttle the requests that can make data modifications because they are more likely to be slow and we don't
			// want to block or slow down other activity
			const method = nodeRequest.method;
			if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD') requestHandler(nodeRequest, nodeResponse);
			else throttledRequestHandler(nodeRequest, nodeResponse);
		}));

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
		const { listener, port } = responders[--i];
		if (port === portNum || port === 'all') {
			const callback = nextCallback;
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

type OnUpgradeOptions = {
	port?: number;
	securePort?: number;
	runFirst?: boolean;
};

/**
 * @typedef {(request: unknown, next: Listener) => void | Promise<void>} Listener
 */

const upgradeListeners = [],
	upgradeChains = {};

/**
 *
 * @param {Listener} listener
 * @param {OnUpgradeOptions} options
 * @returns
 */
function onUpgrade(
	listener: (request: Request, next: (request: Request) => Response) => void,
	options: OnUpgradeOptions
) {
	for (const { port } of getPorts(options)) {
		upgradeListeners[options?.runFirst ? 'unshift' : 'push']({ listener, port });
		upgradeChains[port] = makeCallbackChain(upgradeListeners, port);
	}
}

type OnWebSocketOptions = {
	port?: number;
	securePort?: number;
	maxPayload?: number;
	isOperationsServer?: boolean;
	mtls?: boolean;
};
const websocketListeners = [],
	websocketChains = {};
/**
 *
 * @param {Listener} listener
 * @param {OnWebSocketOptions} options
 * @returns
 */
function onWebSocket(listener: (ws: WebSocket) => void, options: OnWebSocketOptions) {
	const servers = [];

	for (const { port, secure } of getPorts(options)) {
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
				try {
					const request = new Request(incomingMessage);
					request.isWebSocket = true;
					const chainCompletion = httpChain[port](request);
					harperLogger.debug('Received WS connection, calling listeners', websocketListeners);
					websocketChains[port](ws, request, chainCompletion);
				} catch (error) {
					harperLogger.warn('Error in handling WS connection', error);
				}
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
	logRequest(request, 404, 0, request.requestId);
}
let httpLogger: any;

export function logRequest(nodeRequest: IncomingMessage, status: number, requestId: number, executionTime?: number) {
	const logging = httpOptions.logging;
	if (logging) {
		if (!httpLogger) {
			httpLogger = harperLogger.forComponent('http');
		}
		const level = status < 400 ? 'info' : status === 500 ? 'error' : 'warn';
		httpLogger[level]?.(
			`${nodeRequest.method} ${nodeRequest.url} ${nodeRequest.socket.encrypted ? 'HTTPS' : 'HTTP'}/${nodeRequest.httpVersion}${
				logging.headers ? ' ' + headersToString(nodeRequest.headers) : ''
			} ${status}${logging.timing && executionTime ? ' ' + executionTime.toFixed(2) + 'ms' : ''}${requestId ? ' id: ' + requestId : ''}`
		);
	}
}
function headersToString(headers: any) {
	const result: string[] = [];
	for (const name in headers) {
		result.push(`${name}: ${headers[name]}`);
	}
	return result.join(', ');
}
let nextRequestId: BigInt64Array;
export function getRequestId() {
	if (!nextRequestId) {
		nextRequestId = new BigInt64Array([1n]);
		nextRequestId = new BigInt64Array(
			databases.system.hdb_analytics.primaryStore.getUserSharedBuffer('next-request-id', nextRequestId.buffer)
		);
	}
	return Number(Atomics.add(nextRequestId, 0, 1n));
}
