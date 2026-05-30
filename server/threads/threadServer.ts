import * as inspector from 'node:inspector';
import { isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';
import { createServer as createSocketServer } from 'node:net';
import { unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import * as loaded from '../loadRootComponents.ts';
let componentsLoadedResolve;
export const whenComponentsLoaded = new Promise((resolve) => {
	componentsLoadedResolve = resolve;
});

import harperLogger from '../../utility/logging/harper_logger.ts';
import * as env from '../../utility/environment/environmentManager.ts';
import * as terms from '../../utility/hdbTerms.ts';
import { server } from '../Server.ts';
import { createServer as createSecureSocketServer } from 'node:tls';
import { restartNumber, getWorkerIndex } from './manageThreads.ts';
import { realExit } from './workerProcessGuard.ts';
import { isBun } from '../serverHelpers/Request.ts';
import { createTLSSelector } from '../../security/keys.ts';
import { startupLog } from '../../bin/run.ts';
import { SERVERS, setPortServerMap, portServer } from '../serverRegistry.ts';
import * as httpComponent from '../http.ts';
import * as globals from '../../globals.js';
import { onStartup } from '../../utility/lifecycle.ts';
import { getComponentName } from '../../components/componentLoader.ts';
const debugThreads = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG);
const isWindows = process.platform === 'win32';

if (!isBun) {
	if (debugThreads) {
		let port;
		if (isMainThread) {
			port = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG_PORT) ?? 9229;
			const closeInspector = () => {
				try {
					inspector.close();
				} catch (error) {
					harperLogger.info('Could not close debugger', error);
				}
			};
			for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT', 'exit']) {
				process.on(signal, closeInspector);
			}
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
				inspector.open(port, host, waitForDebugger);
			} catch (error) {
				harperLogger.trace(`Could not start debugging on port ${port}, you may already be debugging:`, error.message);
			}
		}
	} else if (process.env.DEV_MODE && isMainThread) {
		try {
			inspector.open(9229);
		} catch (error) {
			if (restartNumber <= 1)
				harperLogger.trace('Could not start debugging on port 9229, you may already be debugging:', error.message);
		}
	}
}

process.on('uncaughtException', (error: any) => {
	if (error.isHandled) return;
	if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') return; // that's what network connections do
	if (error.message === 'write EIO') return; // that means the terminal is closed
	harperLogger.error('uncaughtException', error);
});
// In both Node.js 15+ and Bun, an unhandled promise rejection exits the worker unless a
// handler is registered. Without this, any async path that rejects without being caught
// (e.g. a cache-update commit error when the caller has already resolved) will kill the
// worker thread. Mirror the uncaughtException behavior: log and continue.
process.on('unhandledRejection', (reason: any) => {
	if (reason?.isHandled) return;
	harperLogger.error('unhandledRejection', reason);
});
export { globals };
export { listenOnPorts };
export { startServers };
export { closeServers };
function closeServers() {
	if (isBun) {
		// Bun servers use .stop() for graceful shutdown
		for (let port in SERVERS) {
			const server = SERVERS[port];
			if (server?.stop) {
				server.stop();
			} else if (server?.close) {
				server.close();
			}
		}
		// Give pending requests time to finish, then exit
		return new Promise((resolve) => setTimeout(resolve, 5000).unref());
	}
	const promises = [];
	for (let port in SERVERS) {
		const server = SERVERS[port];
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
				if (!server[connectionsSymbol]) {
					if (forceClose) server.closeAllConnections?.();
					clearInterval(timer);
					return;
				}
				const connections = server[connectionsSymbol][forceClose ? 'all' : 'idle']?.() || [];
				if (connections.length === 0) {
					if (forceClose) clearInterval(timer);
					return;
				}
				if (closeAttempts === 1) harperLogger.info(`Closing ${connections.length} idle connections`);
				else if (forceClose) harperLogger.warn(`Forcefully closing ${connections.length} active connections`);
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
		promises.push(
			new Promise<void>((resolve) => {
				server.close?.(() => {
					resolve();
				});
				// We hope for a graceful exit once all connections have been closed, and no
				// more incoming connections are accepted, but if we need to, we eventually will exit
				setTimeout(() => {
					if (!server.cantCleanupProperly) harperLogger.warn('Had to forcefully exit the server', port, threadId);
					resolve();
				}, 5000).unref();
			})
		);
	}
	return Promise.all(promises);
}

function startServers() {
	const rootPath = env.get(terms.CONFIG_PARAMS.ROOTPATH);
	if (rootPath) {
		try {
			process.chdir(rootPath);
		} catch {
			// ignore any errors with this; just a best effort for now
		}
	}
	const loadedPromise = loaded.loadRootComponents(true).then(() => {
		parentPort
			?.on('message', (message) => {
				if (message.type === terms.ITC_EVENT_TYPES.SHUTDOWN) {
					harperLogger.trace('received shutdown request', threadId);
					// shutdown (for these threads) means stop listening for incoming requests (finish what we are working) and
					// close connections as possible, then let the event loop complete
					closeServers().then(() => {
						realExit(0);
					});
					// Clean up per-thread UDS socket and metadata files
					httpComponent.cleanupUdsFiles();
					if (!isBun && (debugThreads || process.env.DEV_MODE)) {
						try {
							inspector.close();
						} catch (error) {
							harperLogger.info('Could not close debugger', error);
						}
					}
				}
			})
			.ref(); // use this to keep the thread running until we are ready to shutdown and clean up handles
		const listening = listenOnPorts();

		// notify that we are now ready to start receiving requests. Chained with
		// `return` so the outer loadedPromise / whenComponentsLoaded only fulfils
		// once HTTP/HTTPS sockets are actually bound — apitests await that.
		return Promise.resolve(listening).then(() => {
			if (getWorkerIndex() === 0) {
				try {
					startupLog(portServer);
				} catch (err) {
					console.error('Error displaying start-up log', err);
				}
			}
			parentPort?.postMessage({ type: terms.ITC_EVENT_TYPES.CHILD_STARTED });
		});
	});
	componentsLoadedResolve(loadedPromise);
	// Clean up UDS files and force-close Bun server connections on unexpected exit.
	// Without the stop(true) call, clients holding keep-alive connections to a dead Bun
	// worker never receive a FIN/RST and hang indefinitely waiting for a response.
	process.on('exit', () => {
		if (isBun) {
			for (const port in SERVERS) {
				const srv = SERVERS[port];
				if (srv?.stop) {
					try {
						srv.stop(true); // force-close all connections immediately
					} catch {}
				}
			}
		}
		httpComponent.cleanupUdsFiles();
	});
}
let listening;
function listenOnPorts() {
	if (isBun) return listenOnPortsBun();
	if (listening) return Promise.all(listening); // already set up
	listening = [];
	for (let port in SERVERS) {
		const server = SERVERS[port];

		// If server is unix domain socket
		if (port.includes?.('/')) {
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

		try {
			const lastColon = port.lastIndexOf(':');
			if (lastColon > 0)
				// if there is a colon, we assume it is a host:port pair, and then strip brackets as that is a common way to
				// specify an IPv6 address
				listen_on = {
					host: port.slice(0, lastColon).replace(/[[\]]/g, ''),
					port: +port.slice(lastColon + 1),
					reusePort: !isWindows && !server.noReusePort,
				};
			else listen_on = { port: +port, host: '::', reusePort: !isWindows && !server.noReusePort };
			if (isNaN(listen_on.port)) continue;
		} catch (error) {
			harperLogger.error(`Unable to bind to port ${port}`, error);
			continue;
		}
		listening.push(
			new Promise((resolve, reject) => {
				server
					.listen(listen_on, () => {
						resolve({ port, name: server.name, protocol_name: server.protocol_name });
						harperLogger.trace('Listening on port ' + port, threadId);
					})
					.on('error', (err) => {
						// Node.js before v20.11.1 does not properly support reusePort for net.Server —
						// workers receive EADDRINUSE even though the main thread bound with reusePort: true.
						// Resolve rather than reject so the worker can proceed, matching the same graceful
						// handling already present in listenOnPortsBun().
						if (err.code === 'EADDRINUSE') resolve({ port, name: server.name, protocol_name: server.protocol_name });
						else reject(err);
					});
			})
		);
	}
	return Promise.all(listening);
}

async function listenOnPortsBun() {
	const isMac = process.platform === 'darwin';
	const bunServeConfigs = httpComponent.bunServeConfigs;
	for (let port in bunServeConfigs) {
		const config = bunServeConfigs[port];
		const threadRange = env.get(terms.CONFIG_PARAMS.HTTP_THREADRANGE);
		if (threadRange) {
			let threadRangeArray = typeof threadRange === 'string' ? threadRange.split('-') : threadRange;
			let threadIndex = getWorkerIndex();
			if (threadIndex < threadRangeArray[0] || threadIndex > threadRangeArray[1]) {
				continue;
			}
		}
		try {
			// Parse "host:port" strings the same way as listenOnPorts() does for Node
			let portHostname;
			let portNumber;
			const lastColon = String(port).lastIndexOf(':');
			if (lastColon > 0 && !String(port).startsWith('/')) {
				portHostname = String(port).slice(0, lastColon).replace(/[[\]]/g, '');
				portNumber = +String(port).slice(lastColon + 1);
			} else {
				portNumber = +port;
			}
			const serveOptions: any = {
				port: portNumber,
				reusePort: !isWindows && !isMac,
				fetch: config.fetch,
			};
			if (portHostname) serveOptions.hostname = portHostname;
			// Add TLS config if this is a secure server
			if (config.isSecure && config.tlsSelector) {
				// Wait for TLS certs to be loaded
				const defaultContext = await config.tlsSelector.ready;
				if (defaultContext) {
					const tlsOpts: any = {
						cert: defaultContext.options.cert,
						key: defaultContext.options.key,
					};
					// Bun expects ca as string or array of strings; only include if valid
					let ca = defaultContext.options.ca;
					if (ca) {
						if (Array.isArray(ca)) ca = ca.filter((entry) => typeof entry === 'string');
						if (typeof ca === 'string' || (Array.isArray(ca) && ca.length > 0)) {
							tlsOpts.ca = ca;
						}
					}
					serveOptions.tls = tlsOpts;
				}
				// Set up listener for cert updates to reload TLS
				const pseudoServer = config.pseudoServer;
				if (pseudoServer?.secureContextsListeners) {
					pseudoServer.secureContextsListeners.push(() => {
						const updatedCtx = config.tlsSelector.defaultContext;
						if (updatedCtx && SERVERS[port]?.reload) {
							const tlsUpdate: any = {
								cert: updatedCtx.options.cert,
								key: updatedCtx.options.key,
							};
							let ca = updatedCtx.options.ca;
							if (ca) {
								if (Array.isArray(ca)) ca = ca.filter((entry) => typeof entry === 'string');
								if (typeof ca === 'string' || (Array.isArray(ca) && ca.length > 0)) {
									tlsUpdate.ca = ca;
								}
							}
							SERVERS[port].reload({ tls: tlsUpdate });
						}
					});
				}
			}
			// Add WebSocket handlers if configured
			if (config.websocket) {
				serveOptions.websocket = config.websocket;
			}
			// If this is a unix domain socket path
			if (String(port).includes('/')) {
				if (existsSync(port)) unlinkSync(port);
				serveOptions.unix = port;
				delete serveOptions.port;
			}
			if (isNaN(serveOptions.port)) continue;
			// @ts-expect-error - Bun is a runtime global only available in Bun environment
			const bunServer = Bun.serve(serveOptions);
			SERVERS[port] = bunServer;
			harperLogger.trace('Bun listening on port ' + port, threadId);

			// Create a corresponding Unix Domain Socket mirror for secure ports
			if (config.isSecure && env.get(terms.CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS)) {
				const socketsDir = join(env.getHdbBasePath(), 'sockets');
				mkdirSync(socketsDir, { recursive: true });
				const socketName = `${getWorkerIndex()}-${port}`;
				const udsPath = join(socketsDir, `${socketName}.sock`);
				const yamlPath = join(socketsDir, `${socketName}.yaml`);
				if (existsSync(udsPath)) unlinkSync(udsPath);

				// Create a plain HTTP Bun server on the UDS (no TLS)
				// @ts-expect-error - Bun is a runtime global only available in Bun environment
				const udsServer = Bun.serve({
					unix: udsPath,
					fetch: config.fetch,
					websocket: config.websocket,
				});
				SERVERS[udsPath] = udsServer;
				httpComponent.registerUdsCleanupPaths(udsPath, yamlPath);

				const writeMetadata = () => httpComponent.writeUdsMetadata(yamlPath, port, config.pseudoServer);
				config.tlsSelector.ready.then(writeMetadata);
				config.pseudoServer?.secureContextsListeners?.push(writeMetadata);
				harperLogger.info('Domain socket listening on ' + udsPath);
			}
		} catch (error) {
			harperLogger.error(`Unable to start Bun server on port ${port}`, error);
		}
	}
	// Also start any non-HTTP servers (raw socket servers) that were registered in SERVERS
	const listening = [];
	for (let port in SERVERS) {
		const server = SERVERS[port];
		// Skip Bun servers (they're already listening) and config objects
		if (server?.stop || bunServeConfigs[port]) continue;
		if (server?.listen) {
			if (port.includes?.('/')) {
				if (existsSync(port)) unlinkSync(port);
				listening.push(
					new Promise((resolve, reject) => {
						server
							.listen({ path: port }, () => {
								resolve({ port });
								harperLogger.info('Domain socket listening on ' + port);
							})
							.on('error', reject);
					})
				);
			} else {
				const lastColon = String(port).lastIndexOf(':');
				const rawHostname = lastColon > 0 ? String(port).slice(0, lastColon).replace(/[[\]]/g, '') : null;
				const portNum = lastColon > 0 ? +String(port).slice(lastColon + 1) : +port;
				listening.push(
					new Promise((resolve, reject) => {
						server
							.listen({ port: portNum, host: rawHostname || (isMac ? '0.0.0.0' : '::') }, () => {
								resolve({ port });
								harperLogger.trace('Listening on port ' + port, threadId);
							})
							.on('error', (err) => {
								// Another worker already bound this port — that's fine
								if (err.code === 'EADDRINUSE') resolve({ port });
								else reject(err);
							});
					})
				);
			}
		}
	}
	return Promise.all(listening);
}
if (!isMainThread && !workerData?.noServerStart) {
	// Workers start with an empty environment manager. Run the same init+startup
	// sequence as the main entry (bin/harper.ts) before bringing up servers.
	// startServers schedules its loadRootComponents().then(...) chain internally
	// and notifies the parent via parentPort.postMessage(CHILD_STARTED) once the
	// HTTP port is bound — don't await it here, otherwise the worker IIFE blocks
	// on the same chain that main is waiting on, deadlocking the startup.
	(async () => {
		env.initSync();
		const { runStartup } = await import('../../utility/lifecycle.ts');
		await runStartup();
		startServers();
	})().catch((err) => {
		harperLogger.fatal('Worker failed to start', err);
		process.exit(1);
	});
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
		const SNICallback = createTLSSelector('server', options.mtls);
		const tlsConfig = env.get('tls');
		socketServer = createSecureSocketServer(
			{
				rejectUnauthorized: Boolean(options.mtls?.required),
				requestCert: Boolean(options.mtls),
				noDelay: true, // don't delay for Nagle's algorithm, it is a relic of the past that slows things down: https://brooker.co.za/blog/2024/05/09/nagle.html
				keepAlive: true,
				keepAliveInitialDelay: 600, // 10 minute keep-alive, want to be proactive about closing unused connections
				// For some reason ciphers doesn't work from the secure context, despite node docs claiming it would. Lost
				// count of how many node TLS bugs that makes
				ciphers: tlsConfig.ciphers ?? tlsConfig[0]?.ciphers,
				SNICallback,
			},
			listener
		);
		SNICallback.initialize(socketServer);
		socketServer.noReusePort = true;
		SERVERS[options.securePort] = socketServer;

		// Create a corresponding Unix Domain Socket mirror for the secure socket
		if (env.get(terms.CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS)) {
			const socketsDir = join(env.getHdbBasePath(), 'sockets');
			mkdirSync(socketsDir, { recursive: true });
			const socketName = `${getWorkerIndex()}-${options.securePort}`;
			const udsPath = join(socketsDir, `${socketName}.sock`);
			const yamlPath = join(socketsDir, `${socketName}.yaml`);

			const udsServer: any = createSocketServer(
				{ allowHalfOpen: false, noDelay: true, keepAlive: true, keepAliveInitialDelay: 600 } as any,
				listener
			);

			udsServer.isPerThreadSocket = true;
			SERVERS[udsPath] = udsServer;
			httpComponent.registerUdsCleanupPaths(udsPath, yamlPath);

			const writeMetadata = () => httpComponent.writeUdsMetadata(yamlPath, options.securePort, socketServer);
			SNICallback.ready.then(writeMetadata);
			socketServer.secureContextsListeners.push(writeMetadata);
		}
	}
	if (options.port) {
		setPortServerMap(options.port, { protocol_name: 'TCP', name: getComponentName() });
		socketServer = createSocketServer(
			{ allowHalfOpen: false, noDelay: true, keepAlive: true, keepAliveInitialDelay: 600 } as any,
			listener
		);
		socketServer.noReusePort = true;
		SERVERS[options.port] = socketServer;
	}
	return socketServer;
}

// Wire server singletons during the startup phase
onStartup(() => {
	server.socket = onSocket;
});
