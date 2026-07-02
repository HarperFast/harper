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
import { getConfigPath } from '../config/configUtils.ts';
import { getTicketKeys, getWorkerIndex } from './threads/manageThreads.js';
import { createTLSSelector } from '../security/keys.ts';
import { createSecureServer, createServer as createH2CServer } from 'node:http2';
import { createServer as createSecureServerHttp1 } from 'node:https';
import { createServer, IncomingMessage, validateHeaderName, validateHeaderValue } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { Request, BunRequest, UwsRequest, isBun } from './serverHelpers/Request.ts';
import { appendHeader, Headers, toWriteHeadHeaders } from './serverHelpers/Headers.ts';
import { Blob } from '../resources/blob.ts';
import { recordAction, recordActionBinary } from '../resources/analytics/write.ts';
import { Readable, Writable, pipeline } from 'node:stream';
import { mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { server, type ServerOptions, type HttpOptions, type UpgradeOptions, UpgradeListener } from './Server.ts';
import { setPortServerMap, SERVERS } from './serverRegistry.ts';
import { getComponentName } from '../components/componentLoader.ts';
import { throttle } from './throttle.ts';
import { makeCallbackChain as buildCallbackChain, describeChains } from './middlewareChain.ts';
import { WebSocketServer } from 'ws';

const { errorToString, errorForLog } = harperLogger;
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
// uWS backend (#914): stores { socketPath, secure, handler } configs keyed by UDS path. When
// HARPER_UWS_UDS is set, the per-worker UDS mirror is served by uWebSockets.js instead of a Node
// http server; threadServer.js consumes these and calls createUwsServer(). Symphony must forward
// client identity via X-Forwarded-For (not the PROXY protocol) on these sockets, as the Bun path does.
export const uwsServeConfigs: Record<string, any> = {};
// Stores non-function listeners (e.g. Fastify servers) per port for fallback delegation on the
// backends that don't register their own Node http server (Bun, and the uWS HTTP path). Keeping
// them out of SERVERS is what prevents a competing Node server from binding the same port.
const fallbackServers: Record<string | number, any> = {};
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
export function writeUdsMetadata(yamlPath: string, port: number | string, secureServer: any, protocol?: string) {
	const contexts = secureServer.secureContexts;
	let yaml = `pid: ${process.pid}\ntid: ${currentThreadId()}\nport: ${port}\n`;
	// Which application protocol this socket speaks (absent = http/1.1, the historical
	// default) — lets a fronting proxy route by negotiated ALPN.
	if (protocol) yaml += `protocol: ${protocol}\n`;
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

// Entries in `universalHeaders` that were pushed by `applySecurityHeaders`, so a config
// hot-reload can remove exactly the entries it owns without clobbering entries pushed by
// other components.
let ownedSecurityHeaders: [string, string][] = [];

/** Validate and apply `http.securityHeaders` config into `universalHeaders`, replacing any entries owned by a prior call. */
function applySecurityHeaders(securityHeaders: HttpOptions['securityHeaders']) {
	for (const entry of ownedSecurityHeaders) {
		const index = universalHeaders.indexOf(entry);
		if (index !== -1) universalHeaders.splice(index, 1);
	}
	ownedSecurityHeaders = [];
	if (!securityHeaders) return;
	for (const name in securityHeaders) {
		const value = '' + securityHeaders[name];
		try {
			validateHeaderName(name);
			validateHeaderValue(name, value);
		} catch (error) {
			harperLogger.error(`Invalid http.securityHeaders entry "${name}": ${errorToString(error)}`);
			continue;
		}
		const entry: [string, string] = [name, value];
		ownedSecurityHeaders.push(entry);
		universalHeaders.push(entry);
	}
}

export function handleApplication(scope: Scope) {
	httpOptions = scope.options.getAll() as HttpOptions;
	applySecurityHeaders(httpOptions.securityHeaders);
	scope.options.on('change', (_key) => {
		// TODO: Check to see if the key is something we can or can't handle
		httpOptions = scope.options.getAll() as HttpOptions;
		applySecurityHeaders(httpOptions.securityHeaders);
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
	// The operations API must never fall back to the app http ports: it binds on its own
	// configured port(s)/domain socket only. Falling back here lets a port-less operations-api
	// registration (e.g. an app config that carries an `operationsApi` block with no port)
	// claim http.port/http.securePort on the main thread with noReusePort and no upgrade
	// handler, which locks the http workers out of those ports and breaks all WebSockets (#1420).
	if (ports.length === 0 && options?.usageType !== 'operations-api') {
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
			fallbackServers[port] = listener;
		} else if ((httpServers[port] as any)?.uws) {
			// uWS HTTP path (#914, HARPER_UWS_HTTP): the port is backed by uWebSockets.js, not a Node
			// http server, so a raw non-function listener (e.g. Fastify's http.Server via
			// server.http(fastify.server)) must NOT go through registerServer() — that would put it in
			// SERVERS and threadServer would bind a Node http server competing with uWS on the same TCP
			// port. Divert it to the fallback map like the Bun path; makeUwsHandler delegates unhandled
			// requests to it via inject(). The { uws: true } marker is guaranteed present here: the
			// getServer(port) call above (same loop iteration) sets it before this branch runs.
			fallbackServers[port] = listener;
		} else {
			listener.isSecure = secure;
			registerServer(listener, port, false);
		}
		httpChain[port] = makeCallbackChain(httpResponders, port);
	}

	return servers;
}

/**
 * Pipe a stream response body to a Node http response, tracking bytes-sent analytics and tearing
 * the whole chain down on client disconnect or a source error. A bare `pipe()` doesn't forward the
 * source's 'error' event to the destination, and Node throws an unhandled 'error' as an
 * uncaughtException — a generator that throws mid-iteration (e.g. an SSE resource) would otherwise
 * crash the process and leave the response hanging instead of closing (#1763). `pipeline()` wires
 * up destroy-propagation in both directions (client disconnect destroys the source, a source error
 * destroys the response) and, unlike a clean `.end()`, closes the response abruptly on error — which
 * correctly signals a failed/truncated transfer to the client instead of implying it completed.
 */
export function pipeBodyToResponse(
	body: Readable,
	nodeResponse: any,
	handlerPath: string,
	method: string,
	endTime: number
) {
	if (nodeResponse.destroyed || nodeResponse.writableEnded) {
		body.destroy();
		return;
	}
	let bytesSent = 0;
	body.on('data', (data) => {
		bytesSent += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
	});
	pipeline(body, nodeResponse, (error) => {
		if (error) {
			// a client closing the connection mid-stream surfaces as a premature-close error here;
			// that's a routine disconnect, not a failure worth a warning
			if ((error as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') harperLogger.warn(errorForLog(error));
		} else {
			recordAction(performance.now() - endTime, 'transfer', handlerPath, method);
			recordAction(bytesSent, 'bytes-sent', handlerPath, method);
		}
	});
}

function getHTTPServer(port: number, secure: boolean, options: ServerOptions) {
	const { mtls: isMtls, usageType } = options || {};
	const isOperationsServer = usageType === 'operations-api';
	setPortServerMap(port, { protocol_name: secure ? 'HTTPS' : 'HTTP', name: getComponentName() });
	if (!httpServers[port]) {
		// TODO: These should all come from httpOptions or operationsApiOptions
		const serverPrefix = isOperationsServer ? 'operationsApi_network' : (usageType ?? 'http');
		// uWS plaintext-HTTP path (#914, HARPER_UWS_HTTP): back a non-secure TCP HTTP port with
		// uWebSockets.js directly instead of a Node http server. This is the flag used to run the
		// integration suite through uWS (no symphony/UDS needed). WebSocket upgrades are wired on this
		// path via onWebSocket's uWS branch; it's opt-in and separate from HARPER_UWS_UDS.
		const lastColon = String(port).lastIndexOf(':');
		const uwsPort = lastColon > 0 ? +String(port).slice(lastColon + 1) : +port;
		if (
			process.env.HARPER_UWS_HTTP &&
			!secure &&
			!isOperationsServer &&
			!String(port).includes('/') &&
			!Number.isNaN(uwsPort)
		) {
			uwsServeConfigs[port] = {
				port: uwsPort,
				host: lastColon > 0 ? String(port).slice(0, lastColon).replace(/[[\]]/g, '') : undefined,
				secure: false,
				handler: makeUwsHandler(port, isOperationsServer, env.get(serverPrefix + '_requestQueueLimit')),
			};
			// Marker so the httpServers guard is satisfied and the caller has a truthy handle; the
			// actual listen happens in threadServer.js from uwsServeConfigs. onWebSocket() detects
			// this marker (server.uws) and wires native uWS WebSocket handling into the same config.
			httpServers[port] = { uws: true, port } as any;
			return httpServers[port];
		}
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
						// toWriteHeadHeaders converts iterable headers to an object writeHead accepts (a flat
						// array form is required otherwise, and `Array.from` would pass invalid nested tuples).
						else nodeResponse.writeHead(status, toWriteHeadHeaders(headers));
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
					// Only wrap non-stream iterables. Re-wrapping an existing Node stream in
					// `Readable.from()` is redundant and breaks destroy propagation: on client
					// disconnect we destroy the wrapper, which does NOT close the wrapped stream
					// (so e.g. an SSE PassThrough never sees 'close' and its session leaks). A
					// real stream already has `.pipe`, so it flows through the branch below.
					else if (!(body instanceof Readable) && (body[Symbol.iterator] || body[Symbol.asyncIterator]))
						body = Readable.from(body);

					// if it is a stream, pipe it
					if (body?.pipe) pipeBodyToResponse(body, nodeResponse, handlerPath, method, endTime);
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
				// the HTTP status may be carried as `statusCode` (our error classes) or `status` (e.g. a thrown plain object)
				const statusCode = error.statusCode ?? error.status;
				const status = statusCode || 500;
				try {
					nodeResponse.writeHead(status, toWriteHeadHeaders(headers));
				} catch {} // silently ignore errors writing headers, because they may have been set already
				nodeResponse.end(errorToString(error));
				logRequest(nodeRequest, status, requestId, performance.now() - startTime);
				// a status code is interpreted as an expected error, so just info or warn, otherwise log as error
				if (statusCode) {
					if (statusCode === 500) harperLogger.warn(errorForLog(error));
					else harperLogger.info(errorForLog(error));
				} else harperLogger.error(errorForLog(error));
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

			if (process.env.HARPER_UWS_UDS) {
				// uWS backend (#914): serve the UDS mirror with uWebSockets.js instead of a Node http
				// server. threadServer.js consumes uwsServeConfigs and calls createUwsServer(). uWS does
				// not parse the PROXY protocol, so symphony must use sourceAddressHeader: 'xForwardedFor'
				// for this socket (the same mode it uses for the Bun path).
				uwsServeConfigs[udsPath] = {
					socketPath: udsPath,
					secure: true,
					handler: makeUwsHandler(port, isOperationsServer, env.get(serverPrefix + '_requestQueueLimit')),
				};
			} else {
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
						if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD')
							requestHandler(nodeRequest, nodeResponse);
						else throttledRequestHandler(nodeRequest, nodeResponse);
					}
				);

				udsServer.isPerThreadSocket = true;
				enableProxyProtocol(udsServer);
				SERVERS[udsPath] = udsServer;
			}
			registerUdsCleanupPaths(udsPath, yamlPath);

			const writeMetadata = () => writeUdsMetadata(yamlPath, port, server);
			options.SNICallback.ready.then(writeMetadata);
			server.secureContextsListeners.push(writeMetadata);

			// Optional cleartext HTTP/2 mirror (spike: HARPER_H2C_UDS=1). A separate socket
			// (`<worker>-<port>-h2.sock`) so a fronting proxy can route by negotiated ALPN:
			// h2 connections here, http/1.1 to the plain mirror above. The metadata yaml
			// carries `protocol: h2` so the proxy can discover which socket speaks what.
			if (process.env.HARPER_H2C_UDS) {
				const udsPathH2 = join(socketsDir, `${socketName}-h2.sock`);
				const yamlPathH2 = join(socketsDir, `${socketName}-h2.yaml`);
				const h2Server = createH2CServer({}, (nodeRequest: any, nodeResponse: any) => {
					const method = nodeRequest.method;
					if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD') requestHandler(nodeRequest, nodeResponse);
					else throttledRequestHandler(nodeRequest, nodeResponse);
				});
				// A stray non-h2 client (or a truncated preface) fails the session, not the worker.
				h2Server.on('sessionError', (error: Error) => {
					harperLogger.debug('h2c UDS session error:', error);
				});
				const h2Front = createH2CProxyFront(h2Server) as any;
				h2Front.isPerThreadSocket = true;
				SERVERS[udsPathH2] = h2Front;
				registerUdsCleanupPaths(udsPathH2, yamlPathH2);

				const writeMetadataH2 = () => writeUdsMetadata(yamlPathH2, port, server, 'h2');
				options.SNICallback.ready.then(writeMetadataH2);
				server.secureContextsListeners.push(writeMetadataH2);
			}
		}
	}
	return httpServers[port];
}

/**
 * uWS backend (#914): builds the per-request handler for a uWS UDS server. Mirrors the Bun
 * fetchHandler's post-processing (httpChain, unhandled, universalHeaders, Server-Timing,
 * analytics, logging) but returns a plain Harper response descriptor for createUwsServer to
 * serialize onto the uWS HttpResponse. When the chain doesn't handle the request (status === -1)
 * and a Fastify fallback is registered for the port, it delegates via inject() (see injectToFastify),
 * mirroring the Bun path — so legacy Fastify routes work behind uWS too.
 */
function makeUwsHandler(port: number | string, isOperationsServer: boolean, requestQueueLimit?: number) {
	// Build a fresh response descriptor rather than mutating what the chain returned: a handler may
	// return a WHATWG `Response` (read-only `status`/`body` accessors), which the Bun path also never
	// mutates. `headers` is normalized in place the same way the Bun path does.
	const handle = async (request: any) => {
		const startTime = performance.now();
		let requestId = 0;
		if (isOperationsServer) request.isOperationsServer = true;
		if (httpOptions.logging?.id) request.requestId = requestId = getRequestId();
		let response = await httpChain[port](request);
		if (!response) response = unhandled(request);
		let headers = response.headers;
		if (!headers?.set) headers = new Headers(headers);
		for (const [key, value] of universalHeaders) headers.set(key, value);
		if (response.status === -1) {
			// The chain didn't handle it. If a Fastify fallback is registered for this port (legacy
			// custom-function routes via server.http(fastify.server)), delegate to it via inject(),
			// mirroring the Bun path; otherwise it's a genuine 404.
			const fastify = fastifyInstances[port];
			if (fastify) {
				const injectResult = await injectToFastify(fastify, {
					method: request.method,
					url: request.url,
					headers: request.headers.asObject,
					body: request.body, // stream; inject() consumes it as the payload
					user: request.user,
				});
				const respHeaders = new Headers();
				for (const [k, v] of Object.entries(injectResult.headers)) {
					if (v == null) continue;
					// Keep Set-Cookie multi-valued (Harper Headers + writeHeaders emit each separately);
					// only comma-join other repeated headers.
					if (Array.isArray(v)) respHeaders.set(k, k.toLowerCase() === 'set-cookie' ? v : v.join(', '));
					else respHeaders.set(k, String(v));
				}
				logHttpRequest(request, injectResult.statusCode, requestId, performance.now() - startTime);
				const responseStream = injectResult.stream();
				// Event-stream (SSE) responses must reach the client incrementally — stream the body and,
				// on client disconnect, destroy the inject response so the Fastify reply's teardown runs
				// (matches the Bun path). Finite responses buffer so Content-Length stays set.
				if (String(injectResult.headers['content-type'] ?? '').includes('text/event-stream')) {
					const injectResponse = injectResult.raw?.res;
					if (injectResponse && typeof injectResponse.destroy === 'function') {
						responseStream.once('close', () => injectResponse.destroy());
					}
					return { status: injectResult.statusCode, headers: respHeaders, body: responseStream };
				}
				const chunks: Buffer[] = [];
				for await (const chunk of responseStream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				return {
					status: injectResult.statusCode,
					headers: respHeaders,
					body: chunks.length > 0 ? Buffer.concat(chunks) : null,
				};
			}
			logHttpRequest(request, 404, requestId, performance.now() - startTime);
			return { status: 404, headers: new Headers({ 'content-type': 'text/plain' }), body: 'Not found\n' };
		}
		const status = response.status || 200;
		const executionTime = performance.now() - startTime;
		if (!response.handlesHeaders) {
			let serverTiming = `hdb;dur=${executionTime.toFixed(2)}`;
			if (response.wasCacheMiss) serverTiming += ', miss';
			appendHeader(headers, 'Server-Timing', serverTiming, true);
		}
		recordAction(
			executionTime,
			'duration',
			request.handlerPath,
			request.method,
			response.wasCacheMiss == undefined ? undefined : response.wasCacheMiss ? 'cache-miss' : 'cache-hit'
		);
		recordActionBinary(status < 400, 'success', request.handlerPath, request.method);
		recordActionBinary(1, 'response_' + status, request.handlerPath, request.method);
		logHttpRequest(request, status, requestId, executionTime);
		// Static handlers (the only handlesHeaders producers) return a `send` SendStream that writes
		// its own headers/body to a Node ServerResponse via .pipe(). uWS has no such object, and a
		// SendStream doesn't start until piped, so streaming it directly hangs (headers never flush).
		// Pipe it into a Writable shim that captures the headers and buffers the file, mirroring the
		// Bun path. Non-handlesHeaders bodies keep streaming through normalizeUwsBody.
		if (response.handlesHeaders && response.body && typeof response.body.pipe === 'function') {
			// send() may return 304 (conditional GET) or 206/416 (Range) — honor the status it set.
			const sent = await bufferSendStream(response.body, headers, status, request.signal);
			return { status: sent.status, headers, handlesHeaders: true, body: sent.body };
		}
		const body = await normalizeUwsBody(response.body, request.signal);
		return { status, headers, handlesHeaders: response.handlesHeaders, body };
	};
	// Shed data-modifying requests when the event queue is backed up (503), mirroring the Node UDS
	// path — GET/OPTIONS/HEAD are cheap and always run, everything else goes through the throttle.
	const throttledHandle = throttle(
		handle,
		(_request: any) => {
			recordAction(true, 'service-unavailable', port);
			return {
				status: 503,
				headers: new Headers({ 'content-type': 'text/plain' }),
				body: 'Service unavailable, exceeded request queue limit',
			};
		},
		requestQueueLimit
	);
	return (request: any) => {
		const method = request.method;
		if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD') return handle(request);
		return throttledHandle(request);
	};
}

/**
 * uWS: normalize a Harper response body into what the adapter can serialize. Finite bodies collapse
 * to a string/Buffer; a Node stream or async-iterable is returned as a Readable so writeResponse can
 * stream it incrementally (buffering an SSE/event-stream body here would never return). `signal`
 * aborts the collapse of a sync iterable if the client disconnects mid-response.
 */
/**
 * Drive a `send` SendStream to completion against a Writable shim, capturing the headers it writes
 * (setHeader/writeHead) onto `headers` and the status it sets (statusCode/writeHead) and buffering
 * the file body. `send` targets an http.ServerResponse (setHeader/writeHead/statusCode/finished);
 * uWS has none, so we adapt — mirrors the Bun fetchHandler's SendStream path. The captured status
 * carries send's conditional-GET (304) and Range (206/416) results. Buffering is fine for static
 * assets and keeps Content-Length set. `defaultStatus` is used when send sets none.
 */
function bufferSendStream(
	body: any,
	headers: Headers,
	defaultStatus: number,
	signal?: AbortSignal
): Promise<{ body: Buffer; status: number }> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const dest: any = new Writable({
			write(chunk, _encoding, callback) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				callback();
			},
			final(callback) {
				callback();
				resolve({ body: Buffer.concat(chunks), status: dest.statusCode || defaultStatus });
			},
		});
		Object.assign(dest, {
			setHeader: (n: string, v: any) => headers.set(n, v),
			getHeader: (n: string) => headers.get(n),
			removeHeader: (n: string) => (headers as any).delete(n.toLowerCase()),
			// send conveys 304/206/416 via statusCode and/or writeHead's status arg — capture both so
			// conditional-GET and Range responses aren't flattened to the default 200.
			writeHead: (s: number, hdrs?: any) => {
				if (s) dest.statusCode = s;
				if (hdrs) for (const k in hdrs) headers.set(k, hdrs[k]);
			},
			statusCode: defaultStatus,
			headersSent: false,
			// 'on-finished' (used by 'send') treats a non-false `finished` as already-done and destroys
			// the read stream before data flows; keep it false so it waits for the 'finish' event.
			finished: false,
		});
		const onAbort = () => {
			body.destroy?.();
			dest.destroy?.();
			reject(new Error('client aborted'));
		};
		if (signal) {
			if (signal.aborted) return onAbort();
			signal.addEventListener('abort', onAbort, { once: true });
		}
		body.on('error', reject);
		dest.on('error', reject);
		body.pipe(dest);
	});
}

async function normalizeUwsBody(
	body: any,
	signal?: AbortSignal
): Promise<string | Buffer | Uint8Array | Readable | null> {
	if (body == null) return null;
	if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return body;
	if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
	if (typeof body.then === 'function') return normalizeUwsBody(await body, signal);
	// Already a Node stream — stream it as-is (re-wrapping in Readable.from breaks destroy propagation).
	if (typeof body.pipe === 'function') return body;
	// Async-iterable (e.g. an event queue) — adapt to a Readable and stream it.
	if (body[Symbol.asyncIterator]) return Readable.from(body);
	// Sync iterable — small/finite, collapse to a buffer.
	if (body[Symbol.iterator]) {
		const chunks: Buffer[] = [];
		for (const chunk of body) {
			if (signal?.aborted) throw new Error('client aborted');
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	}
	return String(body);
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
					const fallbackServer = fallbackServers[port];
					if (fallbackServer) {
						// Delegate to the fallback server (e.g. Fastify) via node:http compatibility.
						// We create a Node-compatible IncomingMessage/ServerResponse and emit 'request'
						// on the fallback server, then capture the response.
						return await bunDelegateToNodeServer(fallbackServer, webRequest, request);
					}
					logHttpRequest(request, 404, requestId, performance.now() - startTime);
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
				logHttpRequest(request, status, requestId, executionTime);
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
				// the HTTP status may be carried as `statusCode` (our error classes) or `status` (e.g. a thrown plain object)
				const statusCode = error.statusCode ?? error.status;
				const status = statusCode || 500;
				logHttpRequest(null, status, requestId, performance.now() - startTime);
				if (statusCode) {
					if (statusCode === 500) harperLogger.warn(errorForLog(error));
					else harperLogger.info(errorForLog(error));
				} else harperLogger.error(errorForLog(error));
				return new Response(errorToString(error), { status });
			}
		};

		// Store the config for Bun.serve() — will be started by threadServer.js listenOnPorts()
		// The operations API is main-thread-only and must NOT use SO_REUSEPORT — it's the one
		// exclusive port, which lets tooling (e.g. the integration-test loopback pool) detect an
		// address that's already in use instead of silently co-binding. Mirrors the Node path,
		// which sets server.noReusePort for isOperationsServer (see above).
		const config: any = {
			fetch: fetchHandler,
			reusePort: !isOperationsServer && process.platform !== 'darwin' && process.platform !== 'win32',
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
let fastifyInstances: Record<string | number, any> = {};
export function registerFastifyInstance(port: string | number, instance: any) {
	fastifyInstances[port] = instance;
}
const INTERNAL_USER_HEADER = 'x-harper-internal-pre-auth-user';

/**
 * Run a request through a Fastify instance via inject() — its internal router, no socket needed.
 * Shared by the Bun and uWS fallback-delegation paths. Strips any forged pre-auth header from the
 * client and, when Harper's auth middleware resolved a user without credentials (e.g. AUTHORIZE_LOCAL
 * for loopback in dev), forwards it so Fastify can skip its own auth — only when no Authorization
 * header was supplied, otherwise Fastify's Passport validates the credentials normally.
 * `payloadAsStream` makes inject() resolve as soon as the response headers are written and exposes
 * the body as a Readable, so a long-lived SSE response (the MCP server-push GET) streams instead of
 * buffering forever.
 */
function injectToFastify(
	fastify: any,
	req: { method: string; url: string; headers: Record<string, any>; body?: Buffer | Readable; user?: any }
) {
	const headers: Record<string, any> = {};
	for (const key in req.headers) {
		if (key.toLowerCase() !== INTERNAL_USER_HEADER) headers[key] = req.headers[key];
	}
	// Both callers pass already-lowercased header keys (uWS lowercases at the protocol level →
	// RequestHeaders.asObject; Bun's webRequest.headers.forEach yields lowercase), so the literal
	// 'authorization' lookup is reliable — the pre-auth user is only forwarded when the client sent
	// no credentials of its own.
	if (req.user && !headers['authorization']) {
		headers[INTERNAL_USER_HEADER] = JSON.stringify(req.user);
	}
	return fastify.inject({ method: req.method, url: req.url, headers, payload: req.body, payloadAsStream: true });
}

async function bunDelegateToNodeServer(
	nodeServer: any,
	webRequest: globalThis.Request,
	bunRequest?: any
): Promise<Response> {
	// Check if there's a Fastify instance registered for this port (preferred path)
	for (const port in fallbackServers) {
		if (fallbackServers[port] === nodeServer && fastifyInstances[port]) {
			const fastify = fastifyInstances[port];
			const url = new URL(webRequest.url);
			const body = webRequest.body ? Buffer.from(await webRequest.arrayBuffer()) : undefined;
			const headers: Record<string, string> = {};
			webRequest.headers.forEach((value, key) => {
				headers[key] = value;
			});
			const injectResult = await injectToFastify(fastify, {
				method: webRequest.method,
				url: url.pathname + url.search,
				headers,
				body,
				user: bunRequest?.user,
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
			const responseStream = injectResult.stream();
			// Event-stream responses (MCP SSE) must reach the client incrementally — return
			// the body as a stream. Everything else keeps the prior buffered behavior:
			// drain to a single payload so Content-Length stays set and callers see no change.
			const contentType = String(injectResult.headers['content-type'] ?? '');
			if (contentType.includes('text/event-stream')) {
				// Propagate client disconnect back to the hijacked Fastify reply. When Bun
				// cancels the response body it destroys this stream; destroying the inject
				// response (the same object the SSE adapter listens on for 'close') runs the
				// adapter's teardown, which unsubscribes the session's queue 'data' listener
				// and drops the registry entry. Without this the inject bridge would never
				// signal disconnect and the session would leak — its attached data listener
				// keeps the registry's idle-prune backstop from ever reclaiming it.
				const injectResponse = injectResult.raw?.res;
				if (injectResponse && typeof injectResponse.destroy === 'function') {
					responseStream.once('close', () => injectResponse.destroy());
				}
				return new Response(Readable.toWeb(responseStream) as unknown as BodyInit, {
					status: injectResult.statusCode,
					headers: webHeaders,
				});
			}
			const chunks: Buffer[] = [];
			for await (const chunk of responseStream) chunks.push(Buffer.from(chunk));
			const payload = Buffer.concat(chunks);
			return new Response(payload.length > 0 ? payload : null, {
				status: injectResult.statusCode,
				headers: webHeaders,
			});
		}
	}
	// No Fastify instance found — return 404
	return new Response('Not found\n', { status: 404 });
}

type SerializedRoute = { host?: string; urlPath?: string; order: string[] };
// Resolved order captured at chain-build time, keyed identically to httpChain/upgradeChains/
// websocketChains (kind → port → routes). Reporting the stored build-time order rather than
// recomputing from current responders guarantees get_status matches the callback chain actually
// serving that port — including cases where a late `port: 'all'` registration rebuilds only the
// 'all' chain and leaves a concrete port's chain (and this description) unchanged (#1573).
const resolvedChainDescriptions: Record<string, Record<string, SerializedRoute[]>> = {
	http: {},
	upgrade: {},
	websocket: {},
};

function makeCallbackChain(
	responders: typeof httpResponders,
	portNum: number | string,
	requestArgIndex: number = 0,
	kind: string = 'http'
) {
	const onCycle = () => {
		harperLogger.warn(
			`Cycle detected in ${kind} middleware before/after ordering on port ${portNum}; falling back to registration order.`
		);
	};
	// describeChains reuses the same resolvers as buildCallbackChain, so this is the served order.
	// onCycle is omitted: the build call owns the single cycle warning, and on a cycle describeChains
	// falls back to registration order exactly as the built chain does.
	const routes: SerializedRoute[] = describeChains(responders, portNum).map((route) => ({
		host: route.host,
		urlPath: route.urlPath,
		order: route.order.map((entry) => entry.name ?? '(anonymous)'),
	}));
	resolvedChainDescriptions[kind][portNum] = routes;
	if (harperLogger.debug) {
		for (const route of routes) {
			const scope = route.host || route.urlPath ? ` [${route.host ?? '*'}${route.urlPath ?? ''}]` : '';
			harperLogger.debug(
				`Resolved ${kind} middleware chain on port ${portNum}${scope}: ${route.order.join(' → ') || '(empty)'}`
			);
		}
	}
	return buildCallbackChain(
		responders,
		portNum,
		unhandled,
		onCycle,
		requestArgIndex,
		({ entryName, kind: refKind, target }) => {
			harperLogger.warn(
				`Middleware ordering: ${entryName ? `'${entryName}'` : 'a handler'} requested \`${refKind}: '${target}'\` but no handler named '${target}' is registered on port ${portNum}, so the constraint is ignored. Handler names are the config keys as registered (e.g. 'rest').`
			);
		}
	);
}

/**
 * Returns the resolved middleware order for every built HTTP, upgrade, and WebSocket chain on the
 * current thread, as plain serializable data (listeners omitted). Surfaced via the `get_status`
 * operation so chain placement can be verified on a running instance (#1573). The 'all' pseudo-port
 * is excluded: makeCallbackChain builds a chain for it, but it is not a bound listener (its
 * responders already fold into every concrete port's chain).
 *
 * Note: this reflects the calling thread's built chains. All HTTP worker threads register
 * identically, so any worker's view is representative.
 */
export function describeMiddlewareChains() {
	const concretePorts = (byPort: Record<string, SerializedRoute[]>) => {
		const out: Record<string, SerializedRoute[]> = {};
		for (const port of Object.keys(byPort)) if (port !== 'all') out[port] = byPort[port];
		return out;
	};
	return {
		http: concretePorts(resolvedChainDescriptions.http),
		upgrade: concretePorts(resolvedChainDescriptions.upgrade),
		websocket: concretePorts(resolvedChainDescriptions.websocket),
	};
}
function unhandled(request) {
	if (request.user && request._nodeRequest) {
		// pass on authentication information to the next server (Node fallback delegation via the
		// 'unhandled' event chain). The Bun/uWS adapters have no _nodeRequest; they forward the
		// resolved user to the Fastify fallback via injectToFastify's INTERNAL_USER_HEADER instead.
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
		upgradeChains[port] = makeCallbackChain(upgradeListeners, port, 0, 'upgrade');
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

		if ((server as any)?.uws) {
			// uWS-backed port (HARPER_UWS_HTTP): uWS owns the socket, so route upgrades through uWS's
			// native app.ws() rather than the Node ws.WebSocketServer + server 'upgrade' event. We wire a
			// wsHandler into the shared uwsServeConfig; createUwsServer registers app.ws() when it listens.
			const cfg = uwsServeConfigs[port];
			if (cfg && !cfg.wsHandler) {
				// Honor a configured WebSocket maxPayload on the uWS transport too (else it defaults to 100 MiB).
				if (options.maxPayload != null) cfg.wsMaxPayload = options.maxPayload;
				cfg.wsHandler = (ws: any, upgrade: any) => {
					try {
						const request: any = new UwsRequest({
							method: 'GET',
							url: upgrade.url,
							headers: upgrade.headers,
							secure,
							ip: upgrade.ip,
						});
						request.isWebSocket = true;
						const chainCompletion = httpChain[port](request);
						websocketChains[port](ws, request, chainCompletion);
					} catch (error) {
						harperLogger.warn('Error in handling WS connection', error);
						try {
							ws.close();
						} catch {}
					}
				};
			}
		} else if (!websocketServers[port]) {
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
		websocketChains[port] = makeCallbackChain(websocketListeners, port, 1, 'websocket');

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

/**
 * Front a cleartext HTTP/2 server with optional PROXY v1 handling on a Unix domain socket.
 *
 * enableProxyProtocol() can't be used here: Node's Http2Session consumes the socket's
 * native handle directly, so data never surfaces as JS 'data' events to intercept. The
 * PROXY header must instead be consumed *before* the socket is handed to the HTTP/2
 * server. Bytes beyond the header (typically the coalesced h2 connection preface) are
 * unshifted back onto the socket; the native session picks them up (verified on Node 24
 * — covered by a unit test so a Node upgrade regressing this fails loudly).
 *
 * The returned server's close() also gracefully closes live h2 sessions (GOAWAY,
 * in-flight streams finish) so closeServers()'s generic server.close() drains instead
 * of riding its 5s force-exit backstop — the h1 mirror gets this via http.Server's
 * closeIdleConnections drain, which a net.Server doesn't have.
 */
export function createH2CProxyFront(h2Server, prehandoffTimeout = 10_000) {
	const sessions = new Set<any>();
	const prehandoffSockets = new Set<any>();
	let closing = false;
	h2Server.on('session', (session) => {
		// A connection can be mid-handoff (header read, session not yet created) when
		// close() runs — its session forms after the close sweep, so close it here or
		// it would never receive GOAWAY and would ride the 5s force-exit backstop.
		if (closing) session.close();
		sessions.add(session);
		session.on('close', () => sessions.delete(session));
	});
	const front = createNetServer({ noDelay: true }, (socket) => {
		let buf: Buffer | null = null;
		// Until handoff the h2 session's own handlers aren't attached yet: swallow socket
		// errors (a reset mid-header) and bound how long we'll wait for the header, so a
		// stalled connection can't hold an fd forever.
		prehandoffSockets.add(socket);
		socket.on('close', () => prehandoffSockets.delete(socket));
		const onPrehandoffError = () => socket.destroy();
		socket.on('error', onPrehandoffError);
		const onPrehandoffTimeout = () => socket.destroy();
		socket.setTimeout(prehandoffTimeout, onPrehandoffTimeout);
		const handoff = (rest: Buffer) => {
			prehandoffSockets.delete(socket);
			socket.removeListener('readable', onReadable);
			socket.removeListener('error', onPrehandoffError);
			socket.setTimeout(0);
			socket.removeListener('timeout', onPrehandoffTimeout);
			if (rest.length > 0) socket.unshift(rest);
			h2Server.emit('connection', socket);
		};
		const onReadable = () => {
			let chunk: Buffer;
			while ((chunk = socket.read()) !== null) {
				buf = buf ? Buffer.concat([buf, chunk]) : chunk;
				// Compare against "PROXY " for as many bytes as we have so far; a non-PROXY
				// prefix (e.g. a direct h2 client with no fronting proxy) is handed off as-is.
				const cmpLen = Math.min(PROXY_V1_PREFIX.length, buf.length);
				if (buf.compare(PROXY_V1_PREFIX, 0, cmpLen, 0, cmpLen) !== 0) return handoff(buf);
				const eol = buf.indexOf('\r\n');
				if (eol !== -1) {
					// Complete header: "PROXY TCP4 <src-ip> <dst-ip> <src-port> <dst-port>"
					const parts = buf.toString('latin1', 0, eol).split(' ');
					if (parts.length === 6) {
						// Override the UDS socket's undefined remoteAddress/remotePort with the real
						// client values; http2's compat req.socket proxies through to these.
						Object.defineProperty(socket, 'remoteAddress', { value: parts[2], configurable: true });
						Object.defineProperty(socket, 'remotePort', { value: parseInt(parts[4], 10), configurable: true });
					}
					return handoff(buf.subarray(eol + 2));
				}
				// No CRLF within the spec max — not a valid PROXY header after all.
				if (buf.length >= PROXY_V1_MAX_HEADER) return handoff(buf);
			}
		};
		socket.on('readable', onReadable);
	});
	const netClose = front.close.bind(front);
	front.close = (callback?: (error?: Error) => void) => {
		closing = true;
		for (const session of sessions) session.close();
		// Header-waiting sockets carry no in-flight work; drop them so they can't hold
		// the close callback open for the rest of the pre-handoff timeout.
		for (const socket of prehandoffSockets) socket.destroy();
		h2Server.close();
		return netClose(callback);
	};
	return front;
}

function defaultNotFound(request, response) {
	if (response.headersSent || response.writableEnded) return;
	response.writeHead(404);
	response.end('Not found\n');
	logRequest(request, 404, 0, request.requestId);
}
let httpLogger: any;

function logHttpRequest(request: any, status: number, requestId: number, executionTime?: number) {
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
