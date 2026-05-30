// @ts-nocheck
/**
 * This module represents the HTTP component for Harper, and receives the HTTP options and uses them to configure
 * HTTP servers
 */
import { currentThreadId } from '@harperfast/rocksdb-js';
import { Scope } from '../components/Scope.ts';
import { Socket } from 'node:net';
import harperLogger from '../utility/logging/harper_logger.ts';
import { parentPort } from 'node:worker_threads';
import * as env from '../utility/environment/environmentManager.ts';
import * as terms from '../utility/hdbTerms.ts';
import { getConfigPath } from '../config/configUtils.js';
import { getTicketKeys, getWorkerIndex } from './threads/manageThreads.js';
import { createTLSSelector } from '../security/keys.ts';
import { createSecureServer } from 'node:http2';
import { createServer as createSecureServerHttp1 } from 'node:https';
import { createServer, IncomingMessage } from 'node:http';
import { Request, BunRequest, isBun } from './serverHelpers/Request.ts';
import { appendHeader, Headers } from './serverHelpers/Headers.ts';
import { Blob } from '../resources/blob.ts';
import { recordAction, recordActionBinary } from '../resources/analytics/write.ts';
import { Readable, Writable } from 'node:stream';
import { mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { server, type ServerOptions, type HttpOptions, type UpgradeOptions, UpgradeListener } from './Server.ts';
import { setPortServerMap, SERVERS } from './serverRegistry.ts';
import { getComponentName } from '../components/componentLoader.ts';
import { throttle } from './throttle.ts';
import { makeCallbackChain as buildCallbackChain } from './middlewareChain.ts';
import { WebSocketServer } from 'ws';

const { errorToString } = harperLogger;
server.http = httpServer;
server.request = onRequest;
server.ws = onWebSocket;
server.upgrade = onUpgrade;
const websocketServers = {};
const httpServers = {},
	httpChain = {},
	httpResponders: {
		listener: Function;
		port: number | string;
		name?: string;
		before?: string;
		after?: string;
		urlPath?: string;
		host?: string;
	}[] = [];
let httpOptions: HttpOptions = {};
export const universalHeaders: [string, string][] = [];
// Bun-specific: stores fetch handler configs per port, used by threadServer.js to call Bun.serve()
export const bunServeConfigs: Record<string | number, any> = {};
// Bun-specific: stores non-function listeners (e.g. Fastify servers) per port for fallback delegation
const bunFallbackServers: Record<string | number, any> = {};
const udsCleanupPaths: { socketPath: string; yamlPath: string }[] = [];

export function registerUdsCleanupPaths(socketPath: string, yamlPath: string) {
	udsCleanupPaths.push({ socketPath, yamlPath });
}

export function cleanupUdsFiles() {
	for (const { socketPath, yamlPath } of udsCleanupPaths) {
		try {
			unlinkSync(socketPath);
		} catch {}
		try {
			unlinkSync(yamlPath);
		} catch {}
	}
}

/** Write YAML metadata for a UDS mirror socket, describing the TLS certs from the corresponding secure server. */
export function writeUdsMetadata(yamlPath: string, port: number | string, secureServer: any) {
	const contexts = secureServer.secureContexts;
	let yaml = `pid: ${process.pid}\ntid: ${currentThreadId()}\nport: ${port}\n`;
	yaml += `certificates:\n`;
	if (contexts?.size > 0) {
		const seen = new Set();
		for (const [, ctx] of contexts) {
			if (seen.has(ctx.name)) continue;
			seen.add(ctx.name);
			yaml += `  - name: ${JSON.stringify(ctx.name)}\n`;
			yaml += `    hostnames:\n`;
			for (const [h, c] of contexts) {
				if (c.name === ctx.name) yaml += `      - ${JSON.stringify(h)}\n`;
			}
			if (ctx.options.key_file) {
				yaml += `    privateKeyFile: ${JSON.stringify(join(env.get(terms.CONFIG_PARAMS.ROOTPATH), 'keys', ctx.options.key_file))}\n`;
			}
			if (ctx.options.cert) {
				yaml += `    certificate: |\n`;
				for (const line of ctx.options.cert.trimEnd().split('\n')) {
					yaml += `      ${line}\n`;
				}
			}
			if (ctx.certificateAuthorities?.length > 0) {
				yaml += `    certificateAuthorities:\n`;
				for (const [, ca] of ctx.certificateAuthorities) {
					yaml += `      - |\n`;
					for (const line of ca.trimEnd().split('\n')) {
						yaml += `          ${line}\n`;
					}
				}
			}
		}
	}
	try {
		writeFileSync(yamlPath, yaml);
	} catch (error) {
		harperLogger.error('Error writing UDS metadata to ' + yamlPath, error);
	}
}

/** Clean all files in the sockets directory. Call from main thread on process startup. */
export function cleanupSocketsDirectory() {
	if (!env.get(terms.CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS)) return;
	const socketsDir = join(env.getHdbBasePath(), 'sockets');
	try {
		for (const file of readdirSync(socketsDir)) {
			try {
				unlinkSync(join(socketsDir, file));
			} catch {}
		}
	} catch {}
}

export function handleApplication(scope: Scope) {
	httpOptions = scope.options.getAll() as HttpOptions;
	scope.options.on('change', (_key) => {
		// TODO: Check to see if the key is something we can or can't handle
		httpOptions = scope.options.getAll() as HttpOptions;
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

	if (options?.usageType === 'operations-api' && env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET)) {
		ports.push({
			port: getConfigPath(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET),
			secure: false,
		});
	}
	return ports;
}
export function httpServer(listener, options) {
	const servers = [];

	for (const { port, secure } of getPorts(options)) {
		const getServer = isBun ? getBunHTTPServer : getHTTPServer;
		servers.push(getServer(port, secure, options));
		if (typeof listener === 'function') {
			const entry = {
				listener,
				port: options?.port || port,
				name: options?.name ?? getComponentName(),
				before: options?.before,
				after: options?.after,
				urlPath: options?.urlPath || undefined,
				host: options?.host || undefined,
			};
			httpResponders[options?.runFirst ? 'unshift' : 'push'](entry);
		} else if (isBun) {
			// On Bun, store non-function listeners (e.g. Fastify's http.Server) for fallback delegation
			bunFallbackServers[port] = listener;
		} else {
			listener.isSecure = secure;
			registerServer(listener, port, false);
		}
		httpChain[port] = makeCallbackChain(httpResponders, port);
	}

	return servers;
}
function getHTTPServer(port: number, secure: boolean, options: ServerOptions) {
	const { mtls: isMtls, usageType } = options || {};
	const isOperationsServer = usageType === 'operations-api';
	setPortServerMap(port, { protocol_name: secure ? 'HTTPS' : 'HTTP', name: getComponentName() });
	if (!httpServers[port]) {
		// TODO: These should all come from httpOptions or operationsApiOptions
		const serverPrefix = isOperationsServer ? 'operationsApi_network' : (usageType ?? 'http');
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
				SNICallback: createTLSSelector(usageType ?? 'server', mtls),
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
				for (let [key, value] of universalHeaders) {
					response.headers.set(key, value);
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
						if (request.method !== 'HEAD') {
							headers.set('Content-Length', '0');
						}
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
				try {
					nodeResponse.writeHead(status, headers && (headers[Symbol.iterator] ? Array.from(headers) : headers));
				} catch {} // silently ignore errors writing headers, because they may have been set already
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
		// macOS doesn't support SO_REUSEPORT on all socket types; operations API also doesn't need it
		if (isOperationsServer || process.platform === 'darwin') server.noReusePort = true;

		// Operations API domain socket connections bypass auth (equivalent to local access)
		if (isOperationsServer && String(port).includes('/')) server.bypassLocalAuth = true;

		// Create a corresponding Unix Domain Socket mirror for secure ports
		if (secure && env.get(terms.CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS)) {
			const socketsDir = join(env.getHdbBasePath(), 'sockets');
			mkdirSync(socketsDir, { recursive: true });
			const socketName = `${getWorkerIndex()}-${port}`;
			const udsPath = join(socketsDir, `${socketName}.sock`);
			const yamlPath = join(socketsDir, `${socketName}.yaml`);

			// Create a plain HTTP server (no TLS) with the same request handler
			const udsServer = createServer(
				{
					keepAliveTimeout,
					headersTimeout,
					requestTimeout,
					highWaterMark: 128 * 1024,
					noDelay: true,
					keepAlive: true,
					keepAliveInitialDelay: 600,
					maxHeaderSize: env.get(terms.CONFIG_PARAMS.HTTP_MAXHEADERSIZE),
				},
				(nodeRequest: IncomingMessage, nodeResponse: any) => {
					const method = nodeRequest.method;
					if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD') requestHandler(nodeRequest, nodeResponse);
					else throttledRequestHandler(nodeRequest, nodeResponse);
				}
			);

			udsServer.isPerThreadSocket = true;
			enableProxyProtocol(udsServer);
			SERVERS[udsPath] = udsServer;
			registerUdsCleanupPaths(udsPath, yamlPath);

			const writeMetadata = () => writeUdsMetadata(yamlPath, port, server);
			options.SNICallback.ready.then(writeMetadata);
			server.secureContextsListeners.push(writeMetadata);
		}
	}
	return httpServers[port];
}

/**
 * Bun-specific HTTP server setup. Instead of creating a Node http.Server, we store a fetch handler config
 * that will be passed to Bun.serve() when listenOnPorts() is called in threadServer.js.
 */
function getBunHTTPServer(port: number, secure: boolean, options: ServerOptions) {
	const { usageType } = options || {};
	const isOperationsServer = usageType === 'operations-api';
	setPortServerMap(port, { protocol_name: secure ? 'HTTPS' : 'HTTP', name: getComponentName() });
	if (!httpServers[port]) {
		const serverPrefix = isOperationsServer ? 'operationsApi_network' : (usageType ?? 'http');

		const fetchHandler = async (webRequest: globalThis.Request, bunServer: any): Promise<Response> => {
			const startTime = performance.now();
			let requestId = 0;
			try {
				const request = new BunRequest(webRequest, bunServer, secure) as any;
				if (isOperationsServer) request.isOperationsServer = true;
				if (httpOptions.logging?.id) request.requestId = requestId = getRequestId();
				let response = await httpChain[port](request);
				if (!response) {
					response = unhandled(request);
				}
				if (!response.headers?.set) {
					response.headers = new Headers(response.headers);
				}
				for (let [key, value] of universalHeaders) {
					response.headers.set(key, value);
				}
				if (response.status === -1) {
					const fallbackServer = bunFallbackServers[port];
					if (fallbackServer) {
						// Delegate to the fallback server (e.g. Fastify) via node:http compatibility.
						// We create a Node-compatible IncomingMessage/ServerResponse and emit 'request'
						// on the fallback server, then capture the response.
						return await bunDelegateToNodeServer(fallbackServer, webRequest, request);
					}
					logBunRequest(request, 404, requestId, performance.now() - startTime);
					return new Response('Not found\n', { status: 404 });
				}
				const status = response.status || 200;
				const endTime = performance.now();
				const executionTime = endTime - startTime;
				let body = response.body;
				const responseHeaders = new globalThis.Headers();
				if (!response.handlesHeaders) {
					const headers = response.headers || new Headers();
					let serverTiming = `hdb;dur=${executionTime.toFixed(2)}`;
					if (response.wasCacheMiss) {
						serverTiming += ', miss';
					}
					appendHeader(headers, 'Server-Timing', serverTiming, true);
					// Convert Harper Headers to Web Headers
					if (headers[Symbol.iterator]) {
						for (const [name, value] of headers) {
							if (Array.isArray(value)) {
								for (const v of value) responseHeaders.append(name, v);
							} else if (value != null) {
								responseHeaders.set(name, String(value));
							}
						}
					}
					if (!body) {
						if (request.method !== 'HEAD') {
							responseHeaders.set('Content-Length', '0');
						}
						body = null;
					} else if (body.length >= 0) {
						if (typeof body === 'string') responseHeaders.set('Content-Length', String(Buffer.byteLength(body)));
						else responseHeaders.set('Content-Length', String(body.length));
					} else if (body instanceof Blob) {
						if (body.size) responseHeaders.set('Content-Length', String(body.size));
						body = body.stream();
					}
				}
				// Propagate Connection: close so Bun closes the TCP connection after this response,
				// preventing stale keep-alive sockets from causing silent hangs on subsequent requests.
				if (webRequest.headers.get('connection')?.toLowerCase() === 'close') {
					responseHeaders.set('connection', 'close');
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
				logBunRequest(request, status, requestId, executionTime);
				// Convert body to something Bun's Response can accept
				if (body instanceof ReadableStream) {
					return new Response(body, { status, headers: responseHeaders });
				}
				if (body?.[Symbol.iterator] || body?.[Symbol.asyncIterator]) {
					body = Readable.from(body);
				}
				if (body?.pipe) {
					// Some streams (e.g. SendStream from 'send') call setHeader/writeHead on the
					// pipe destination, expecting an http.ServerResponse. Use a Writable with a
					// minimal shim so those calls capture headers, and buffer the data before
					// returning a Response (avoids Readable.toWeb() compat issues with Bun).
					const chunks: Buffer[] = [];
					const buffer = await new Promise<Buffer>((resolve, reject) => {
						const dest = new Writable({
							write(chunk, _encoding, callback) {
								chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
								callback();
							},
							final(callback) {
								callback();
								resolve(Buffer.concat(chunks));
							},
						});
						Object.assign(dest, {
							setHeader: (n: string, v: string) => responseHeaders.set(n, String(v)),
							getHeader: (n: string) => responseHeaders.get(n),
							removeHeader: (n: string) => responseHeaders.delete(n),
							writeHead: (_s: number, hdrs?: any) => {
								if (hdrs) for (const [k, v] of Object.entries(hdrs)) responseHeaders.set(k, String(v));
							},
							statusCode: status,
							headersSent: false,
							// 'on-finished' (used by 'send') checks msg.finished to see if stream is done.
							// Writable.finished is undefined in Bun (not boolean), so isFinished() returns undefined
							// which !== false, causing on-finished to call cleanup() immediately and destroy the
							// ReadStream before data flows. Setting finished: false makes it wait for 'finish' event.
							finished: false,
						});
						body.on('error', reject);
						dest.on('error', reject);
						body.pipe(dest);
					});
					responseHeaders.set('Content-Length', String(buffer.length));
					return new Response(buffer, { status, headers: responseHeaders });
				}
				if (body?.then) {
					body = await body;
				}
				return new Response(body, { status, headers: responseHeaders });
			} catch (error) {
				const status = error.statusCode || 500;
				logBunRequest(null, status, requestId, performance.now() - startTime);
				if (error.statusCode) {
					if (error.statusCode === 500) harperLogger.warn(error);
					else harperLogger.info(error);
				} else harperLogger.error(error);
				return new Response(errorToString(error), { status });
			}
		};

		// Store the config for Bun.serve() — will be started by threadServer.js listenOnPorts()
		const config: any = {
			fetch: fetchHandler,
			reusePort: process.platform !== 'darwin' && process.platform !== 'win32',
		};
		if (secure) {
			// TLS config for Bun
			const mtls = env.get(serverPrefix + '_mtls');
			const tlsSelector = createTLSSelector(usageType ?? 'server', mtls);
			// Create a pseudo-server object so the TLS selector can store secureContexts on it
			const pseudoServer: any = { ports: [port], secureContexts: null, secureContextsListeners: [] };
			tlsSelector.initialize(pseudoServer);
			config.tlsSelector = tlsSelector;
			config.pseudoServer = pseudoServer;
			config.isSecure = true;
		}

		// Operations API domain socket connections bypass auth
		if (isOperationsServer && String(port).includes('/')) config.bypassLocalAuth = true;

		bunServeConfigs[port] = config;
		httpServers[port] = config; // sentinel so we don't create twice
	}
	return httpServers[port];
}

/**
 * Bridge a Bun fetch request to a Node.js http.Server (e.g. Fastify) by using Fastify's inject()
 * method to send the request through its internal router without needing a real socket.
 */
let bunFastifyInstances: Record<string | number, any> = {};
export function registerBunFastifyInstance(port: string | number, instance: any) {
	bunFastifyInstances[port] = instance;
}
const INTERNAL_USER_HEADER = 'x-harper-internal-pre-auth-user';

async function bunDelegateToNodeServer(
	nodeServer: any,
	webRequest: globalThis.Request,
	bunRequest?: any
): Promise<Response> {
	// Check if there's a Fastify instance registered for this port (preferred path)
	for (const port in bunFallbackServers) {
		if (bunFallbackServers[port] === nodeServer && bunFastifyInstances[port]) {
			const fastify = bunFastifyInstances[port];
			const url = new URL(webRequest.url);
			const body = webRequest.body ? Buffer.from(await webRequest.arrayBuffer()) : undefined;
			const headers: Record<string, string> = {};
			webRequest.headers.forEach((value, key) => {
				// Strip any forged pre-auth header from real clients
				if (key.toLowerCase() !== INTERNAL_USER_HEADER) headers[key] = value;
			});
			// If Harper's auth middleware authenticated this request without credentials (e.g. via
			// AUTHORIZE_LOCAL for loopback connections in dev mode), pass the user so Fastify can
			// skip its own auth. Only applies when there is no Authorization header — if credentials
			// were provided, let Fastify's Passport validate them normally.
			if (bunRequest?.user && !headers['authorization']) {
				headers[INTERNAL_USER_HEADER] = JSON.stringify(bunRequest.user);
			}
			const injectResult = await fastify.inject({
				method: webRequest.method,
				url: url.pathname + url.search,
				headers,
				payload: body,
			});
			const webHeaders = new globalThis.Headers();
			for (const [k, v] of Object.entries(injectResult.headers)) {
				if (v != null) webHeaders.set(k, Array.isArray(v) ? v.join(', ') : String(v));
			}
			// Propagate Connection: close so Bun closes the TCP connection after this response,
			// preventing stale keep-alive sockets from causing silent hangs on subsequent requests.
			if (webRequest.headers.get('connection')?.toLowerCase() === 'close') {
				webHeaders.set('connection', 'close');
			}
			return new Response(injectResult.rawPayload?.length > 0 ? injectResult.rawPayload : null, {
				status: injectResult.statusCode,
				headers: webHeaders,
			});
		}
	}
	// No Fastify instance found — return 404
	return new Response('Not found\n', { status: 404 });
}

function makeCallbackChain(responders: typeof httpResponders, portNum: number | string, requestArgIndex: number = 0) {
	return buildCallbackChain(
		responders,
		portNum,
		unhandled,
		() => {
			harperLogger.warn(
				`Cycle detected in middleware before/after ordering on port ${portNum}; falling back to registration order.`
			);
		},
		requestArgIndex
	);
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
	set(_v) {},
});

const upgradeListeners = [],
	upgradeChains = {};

function onUpgrade(listener: UpgradeListener, options: UpgradeOptions) {
	for (const { port } of getPorts(options)) {
		const entry = {
			listener,
			port: options?.port || port,
			name: options?.name ?? getComponentName(),
			before: options?.before,
			after: options?.after,
			urlPath: options?.urlPath || undefined,
			host: options?.host || undefined,
		};
		upgradeListeners[options?.runFirst ? 'unshift' : 'push'](entry);
		upgradeChains[port] = makeCallbackChain(upgradeListeners, port);
	}
}

type OnWebSocketOptions = {
	port?: number;
	securePort?: number;
	maxPayload?: number;
	usageType?: string;
	mtls?: boolean;
	runFirst?: boolean;
	name?: string;
	before?: string;
	after?: string;
	urlPath?: string;
	host?: string;
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

		const server = getHTTPServer(port, secure, options);

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
					if (request.__harperdbRequestUpgraded || request.__harperRequestUpgraded) {
						return next(request, socket, head);
					}

					// Otherwise, upgrade the socket and then continue
					return websocketServers[port].handleUpgrade(request, socket, head, (ws) => {
						request.__harperdbRequestUpgraded = true;
						request.__harperRequestUpgraded = true;
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

		const wsEntry = {
			listener,
			port: options?.port || port,
			name: options?.name ?? getComponentName(),
			before: options?.before,
			after: options?.after,
			urlPath: options?.urlPath || undefined,
			host: options?.host || undefined,
		};
		websocketListeners[options?.runFirst ? 'unshift' : 'push'](wsEntry);
		websocketChains[port] = makeCallbackChain(websocketListeners, port, 1);

		// mqtt doesn't invoke the http handler so this needs to be here to load up the http chains.
		httpChain[port] = makeCallbackChain(httpResponders, port);
	}

	return servers;
}

// PROXY protocol v1 max header length per spec: 108 bytes
const PROXY_V1_MAX_HEADER = 108;
const PROXY_V1_PREFIX = Buffer.from('PROXY ');

export function enableProxyProtocol(httpServer) {
	// In Node.js v24+, the HTTP parser's data path goes through the C++ stream layer
	// and does not call socket.emit('data') via JavaScript method dispatch.
	// Overriding socket.emit or socket.push has no effect on the HTTP parser's data intake.
	//
	// Instead: use process.nextTick inside the 'connection' handler to wrap the HTTP
	// parser's 'data' listener after it has been registered (synchronously, by the HTTP
	// parser's own 'connection' handler which runs right after ours).
	// process.nextTick fires before any I/O callbacks, so it is guaranteed to run before
	// the first network data chunk reaches the socket — making the interception race-free.
	httpServer.prependListener('connection', (socket) => {
		process.nextTick(() => {
			// Capture the HTTP parser's 'data' listener(s) registered during this connection event.
			const dataListeners = socket.listeners('data') as ((chunk: Buffer) => void)[];
			if (dataListeners.length === 0) return;
			socket.removeAllListeners('data');
			const forward = (chunk: Buffer) => {
				for (const listener of dataListeners) listener.call(socket, chunk);
			};

			let headerHandled = false;
			// Accumulates a possibly-split PROXY header. Raw protocols (MQTT/replication) can't
			// recover from a corrupted first packet, so we must not forward a partial header —
			// the line can arrive across multiple data events.
			let pending: Buffer | null = null;
			socket.on('data', (chunk: Buffer) => {
				if (headerHandled) return forward(chunk);
				if (pending) chunk = Buffer.concat([pending, chunk]);

				// Compare against "PROXY " for as many bytes as we have so far.
				const cmpLen = Math.min(PROXY_V1_PREFIX.length, chunk.length);
				if (chunk.compare(PROXY_V1_PREFIX, 0, cmpLen, 0, cmpLen) !== 0) {
					// Not a PROXY v1 header — forward everything unchanged.
					headerHandled = true;
					pending = null;
					return forward(chunk);
				}

				const header = chunk.toString('latin1', 0, Math.min(PROXY_V1_MAX_HEADER, chunk.length));
				const eol = header.indexOf('\r\n');
				if (eol === -1) {
					// Header not complete yet. Keep buffering until the CRLF arrives, unless we've
					// passed the spec max without one — then it isn't a valid PROXY header.
					if (chunk.length < PROXY_V1_MAX_HEADER) {
						pending = chunk;
						return;
					}
					headerHandled = true;
					pending = null;
					return forward(chunk);
				}

				// Complete header: "PROXY TCP4 <src-ip> <dst-ip> <src-port> <dst-port>"
				headerHandled = true;
				pending = null;
				const parts = header.slice(0, eol).split(' ');
				if (parts.length === 6) {
					// Override the UDS socket's undefined remoteAddress/remotePort with the real client values.
					Object.defineProperty(socket, 'remoteAddress', { value: parts[2], configurable: true });
					Object.defineProperty(socket, 'remotePort', { value: parseInt(parts[4], 10), configurable: true });
				}
				// Forward only the bytes after the PROXY header to the protocol parser.
				const rest = chunk.subarray(eol + 2);
				if (rest.length > 0) forward(rest);
			});
		});
	});
}

function defaultNotFound(request, response) {
	if (response.headersSent || response.writableEnded) return;
	response.writeHead(404);
	response.end('Not found\n');
	logRequest(request, 404, 0, request.requestId);
}
let httpLogger: any;

function logBunRequest(request: any, status: number, requestId: number, executionTime?: number) {
	const logging = httpOptions.logging;
	if (logging) {
		if (!httpLogger) {
			httpLogger = harperLogger.forComponent('http');
		}
		const level = status < 400 ? 'info' : status === 500 ? 'error' : 'warn';
		const method = request?.method || '?';
		const url = request?.url || '?';
		const protocol = request?.protocol === 'https' ? 'HTTPS' : 'HTTP';
		httpLogger[level]?.(
			`${method} ${url} ${protocol}/1.1${
				logging.headers && request?.headers ? ' ' + headersToString(request.headers.asObject || {}) : ''
			} ${status}${logging.timing && executionTime ? ' ' + executionTime.toFixed(2) + 'ms' : ''}${requestId ? ' id: ' + requestId : ''}`
		);
	}
}

export function logRequest(nodeRequest: IncomingMessage, status: number, requestId: number, executionTime?: number) {
	const logging = httpOptions.logging;
	if (logging) {
		if (!httpLogger) {
			httpLogger = harperLogger.forComponent('http');
		}
		const level = status < 400 ? 'info' : status === 500 ? 'error' : 'warn';
		httpLogger[level]?.(
			`${nodeRequest.method} ${nodeRequest.url} ${(nodeRequest.socket as any).encrypted ? 'HTTPS' : 'HTTP'}/${nodeRequest.httpVersion}${
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
