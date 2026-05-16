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
import { restartNumber, getWorkerIndex, extendShutdownDeadline, restoreShutdownDeadline } from './manageThreads.ts';
import { runShutdownDrains, shutdownDrainsHaveWork, getShutdownDrainCeilingMs } from '../../components/shutdownDrain.ts';
import { realExit } from './workerProcessGuard.ts';
import { isBun } from '../serverHelpers/Request.ts';
import { createTLSSelector, getEffectiveTlsCiphers } from '../../security/keys.ts';
import { startupLog } from '../../bin/run.ts';
import { SERVERS, setPortServerMap, portServer } from '../serverRegistry.ts';
import * as httpComponent from '../http.ts';
import * as globals from '../../globals.js';
import { whenScopesClosed } from '../../components/scopeShutdown.ts';
import { onStartup } from '../../utility/lifecycle.ts';

const debugThreads = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG);
const isWindows = process.platform === 'win32';

if (!isBun) {
	if (debugThreads) {
		let port;
		if (isMainThread) {
			port = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG_PORT) ?? 9229;
			const closeInspector = () => {
				try {
					require('inspector').close();
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
}

process.on('uncaughtException', (error) => {
	if (error.isHandled) return;
	if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') return; // that's what network connections do
	if (error.message === 'write EIO') return; // that means the terminal is closed
	harperLogger.error('uncaughtException', error);
});
// In both Node.js 15+ and Bun, an unhandled promise rejection exits the worker unless a
// handler is registered. Without this, any async path that rejects without being caught
// (e.g. a cache-update commit error when the caller has already resolved) will kill the
// worker thread. Mirror the uncaughtException behavior: log and continue.
process.on('unhandledRejection', (reason) => {
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
			new Promise((resolve) => {
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
	loaded.loadRootComponents(true).then(() => {
			parentPort
				?.on('message', (message) => {
					if (message.type === terms.ITC_EVENT_TYPES.SHUTDOWN) {
						harperLogger.trace('received shutdown request', threadId);
						// shutdown (for these threads) means stop listening for incoming requests (finish what we are working) and
						// close connections as possible, then let the event loop complete.
						// First, gracefully drain any in-flight work registered by components — notably a
						// replication blob *send* streaming to a peer, which is cheaper to finish than to interrupt
						// (interrupting leaves the peer's copy diverged until it re-requests). The drain waits only
						// on work still making progress, bounded by an absolute deadline. When there is real work to
						// drain we push the termination backstops out to that deadline first so the drain isn't cut
						// short, then restore the normal short backstop once draining is done — so any later hang
						// (closeServers / scope disposal) is still force-killed on the normal timeout, and a worker
						// with no such work is never affected.
						const drainDeadline = Date.now() + getShutdownDrainCeilingMs();
						const extendedForDrain = shutdownDrainsHaveWork();
						if (extendedForDrain) extendShutdownDeadline(drainDeadline);
						// Wait for application scopes to finish closing before exiting — some dispose a native
						// runtime asynchronously (e.g. @harperfast/vite's rolldown dev server), and exiting the
						// worker while that runtime is still live crashes the process. The manageThreads backstop
						// timers still bound this if a scope's disposal hangs.
						runShutdownDrains(drainDeadline)
							.then(() => {
								if (extendedForDrain) restoreShutdownDeadline();
							})
							.then(() => closeServers())
							.then(() => whenScopesClosed())
							.then(() => {
								realExit(0);
							});
						// Clean up per-thread UDS socket and metadata files
						httpComponent.cleanupUdsFiles();
						if (!isBun && (debugThreads || process.env.DEV_MODE)) {
							try {
								require('inspector').close();
							} catch (error) {
								harperLogger.info('Could not close debugger', error);
							}
						}
					}
				})
				.ref(); // use this to keep the thread running until we are ready to shutdown and clean up handles
			const listening = listenOnPorts();

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
		});
	componentsLoadedResolve(loaded);
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
	return loaded;
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
		let ownerWorkerIndex = 0; // lowest eligible worker index for this port
		const threadRange = env.get(terms.CONFIG_PARAMS.HTTP_THREADRANGE);
		if (threadRange) {
			let threadRangeArray = typeof threadRange === 'string' ? threadRange.split('-') : threadRange;
			let threadIndex = getWorkerIndex();
			if (threadIndex < threadRangeArray[0] || threadIndex > threadRangeArray[1]) {
				continue;
			}
			ownerWorkerIndex = +threadRangeArray[0];
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
		// A dedicated listener (see onSocket()) with an exclusive (non-reusePort) bind is owned by a
		// single deterministic worker — the lowest eligible index — instead of every worker racing
		// for it. Nothing else in-process can then hold its port (the main thread doesn't bind these,
		// and restarts of the owner are non-overlapping on non-reusePort platforms, see
		// restartWorkers()), which is what makes the owner's EADDRINUSE below unambiguously external.
		if (server.dedicatedListener && !listen_on.reusePort && !isMainThread && getWorkerIndex() !== ownerWorkerIndex)
			continue;
		listening.push(
			new Promise((resolve, reject) => {
				server
					.listen(listen_on, () => {
						resolve({ port, name: server.name, protocol_name: server.protocol_name });
						harperLogger.trace('Listening on port ' + port, threadId);
					})
					.on('error', (err) => {
						if (err.code !== 'EADDRINUSE') return reject(err);
						// An EADDRINUSE here is unambiguously an unrelated external process already
						// holding the port (which will silently receive this listener's traffic) when:
						// - the listener uses reusePort: Harper's supported Node fully supports
						//   SO_REUSEPORT, so sibling workers share the port and never raise EADDRINUSE,
						//   even across an overlapping restart (the replacement co-binds while the old
						//   worker is still up); or
						// - this is the main thread: it binds the HTTP/operations ports (awaited) before
						//   any worker starts and never restarts, so nothing in-process can already hold
						//   them; or
						// - this is a dedicated listener's owner worker (gated above): no other thread
						//   binds it, and its restarts are non-overlapping without reusePort.
						// The remaining case — a worker's exclusive HTTP bind on macOS/Windows —
						// deterministically loses to the main thread's earlier bind; that benign
						// EADDRINUSE stays swallowed silently. Resolve either way so one unavailable
						// port doesn't stall the rest of this thread's boot.
						if (listen_on.reusePort || isMainThread || server.dedicatedListener) logExternalBindConflict(port, err);
						resolve({ port, name: server.name, protocol_name: server.protocol_name });
					});
			})
		);
	}
	// uWS spike (#914): start any uWebSockets.js UDS servers registered by http.ts (HARPER_UWS_UDS).
	// These replace the Node http UDS mirror; createUwsServer binds the unix socket and bridges each
	// request through httpChain[port] via UwsRequest.
	const uwsServeConfigs = httpComponent.uwsServeConfigs;
	if (uwsServeConfigs) {
		for (const key in uwsServeConfigs) {
			const cfg = uwsServeConfigs[key];
			if (cfg.socketPath && existsSync(cfg.socketPath)) unlinkSync(cfg.socketPath);
			const { createUwsServer } = require('../serverHelpers/uwsServer.ts');
			listening.push(
				createUwsServer(cfg).then(({ close }) => {
					// Register a minimal server-like entry so closeServers() can tear it down. uWS's
					// close() is synchronous and takes no callback, so wrap it to invoke the callback
					// closeServers() passes; omit closeIdleConnections so the Node keep-alive drain loop
					// (which would spin and then force-exit noisily against this shim) is skipped.
					SERVERS[key] = {
						close(callback) {
							close();
							callback?.();
						},
					};
					harperLogger.info('uWS listening on ' + (cfg.socketPath ?? cfg.port));
					return { port: key };
				})
			);
		}
	}
	return Promise.all(listening);
}

/**
 * Log that a port could not be bound because an unrelated process already holds it — meaning that
 * process, not this listener, will receive the port's traffic. Only called once in-process
 * collisions have been ruled out (reusePort sharing, or the main thread's first-bind ordering),
 * so this is unambiguously external.
 */
function logExternalBindConflict(port, err) {
	// `port` is a string key from `for..in SERVERS`, but portServer may be keyed by the numeric
	// port setPortServerMap() was called with, so fall back to a numeric lookup.
	const registered = portServer.get(port) ?? portServer.get(Number(port));
	const owner = registered?.[registered.length - 1];
	harperLogger.error(
		`Failed to bind ${owner?.protocol_name ?? 'socket'} listener${owner?.name ? ` for component '${owner.name}'` : ''} to port ${port}: address already in use by another process`,
		err
	);
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
			const serveOptions = {
				port: portNumber,
				// Respect the per-server reusePort decision made in http.ts (the operations API
				// opts out so it stays exclusive); fall back to the platform default otherwise.
				reusePort: config.reusePort ?? (!isWindows && !isMac),
				fetch: config.fetch,
			};
			if (portHostname) serveOptions.hostname = portHostname;
			// Add TLS config if this is a secure server
			if (config.isSecure && config.tlsSelector) {
				// Wait for TLS certs to be loaded
				const defaultContext = await config.tlsSelector.ready;
				if (defaultContext) {
					serveOptions.tls = {
						cert: defaultContext.options.cert,
						key: defaultContext.options.key,
					};
					// Bun expects ca as string or array of strings; only include if valid
					let ca = defaultContext.options.ca;
					if (ca) {
						if (Array.isArray(ca)) ca = ca.filter((entry) => typeof entry === 'string');
						if (typeof ca === 'string' || (Array.isArray(ca) && ca.length > 0)) {
							serveOptions.tls.ca = ca;
						}
					}
				}
				// Set up listener for cert updates to reload TLS
				const pseudoServer = config.pseudoServer;
				if (pseudoServer?.secureContextsListeners) {
					pseudoServer.secureContextsListeners.push(() => {
						const updatedCtx = config.tlsSelector.defaultContext;
						if (updatedCtx && SERVERS[port]?.reload) {
							const tlsUpdate = {
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
				// These raw-socket listens bind exclusively (no reusePort), so a dedicated listener
				// gets a single owner worker — same reasoning as listenOnPorts(). Bun restarts are
				// already non-overlapping (see restartWorkers()).
				if (server.dedicatedListener && !isMainThread && getWorkerIndex() !== 0) {
					listening.push(Promise.resolve({ port }));
					continue;
				}
				listening.push(
					new Promise((resolve, reject) => {
						server
							.listen({ port: portNum, host: rawHostname || (isMac ? '0.0.0.0' : '::') }, () => {
								resolve({ port });
								harperLogger.trace('Listening on port ' + port, threadId);
							})
							.on('error', (err) => {
								if (err.code !== 'EADDRINUSE') return reject(err);
								// The main thread binds before any worker and never restarts, and a
								// dedicated listener's owner worker is the only thread that binds it — in
								// both cases EADDRINUSE can only come from an unrelated external process;
								// surface it (see listenOnPorts()). Otherwise another worker already bound
								// the port — that's fine.
								if (isMainThread || server.dedicatedListener) logExternalBindConflict(port, err);
								resolve({ port });
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
	(async () => {
		env.initSync();
		const { runStartup } = await import('../../utility/lifecycle.ts');
		await runStartup();
		await startServers();
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
	let getComponentName = require('../../components/componentLoader.ts').getComponentName;
	let socketServer;
	if (options.securePort) {
		setPortServerMap(options.securePort, { protocol_name: 'TLS', name: getComponentName() });
		const SNICallback = createTLSSelector('server', options.mtls);
		// OpenSSL takes the cipher list (and its @SECLEVEL) from the context the server was created with;
		// a context swapped in by the SNI callback doesn't carry its own cipher list onto the connection.
		// The listener-level string is therefore the only one honored — resolve it from every configured
		// source (see resolveEffectiveTlsCiphers in keys.ts).
		const effectiveCiphers = getEffectiveTlsCiphers('server', options.mtls);
		socketServer = createSecureSocketServer(
			{
				rejectUnauthorized: Boolean(options.mtls?.required),
				requestCert: Boolean(options.mtls),
				noDelay: true, // don't delay for Nagle's algorithm, it is a relic of the past that slows things down: https://brooker.co.za/blog/2024/05/09/nagle.html
				keepAlive: true,
				keepAliveInitialDelay: 600, // 10 minute keep-alive, want to be proactive about closing unused connections
				ciphers: effectiveCiphers,
				SNICallback,
			},
			listener
		);
		socketServer.appliedCiphers = effectiveCiphers ?? null;
		socketServer.verifiesClientCerts = Boolean(options.mtls);
		SNICallback.initialize(socketServer);
		// Only opt out of reusePort on macOS, which doesn't reliably support SO_REUSEPORT on all
		// socket types (ENOTSUP). Everywhere else, sharing the port lets every worker accept
		// connections for this listener (e.g. MQTT), matching how HTTP servers are bound; without
		// it only the first worker to bind serves the port and every sibling's listen() fails with
		// a silently-swallowed EADDRINUSE.
		if (process.platform === 'darwin') socketServer.noReusePort = true;
		// Unlike HTTP/operations ports, these component listeners are never bound by the main
		// thread (components don't run handleApplication there), so a worker owns them. Marking
		// them lets listenOnPorts() give an exclusive (non-reusePort) one a single deterministic
		// owner worker, which makes any EADDRINUSE on it unambiguously an external process.
		socketServer.dedicatedListener = true;
		SERVERS[options.securePort] = socketServer;

		// Create a corresponding Unix Domain Socket mirror for the secure socket
		if (env.get(terms.CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS)) {
			const socketsDir = join(env.getHdbBasePath(), 'sockets');
			mkdirSync(socketsDir, { recursive: true });
			const socketName = `${getWorkerIndex()}-${options.securePort}`;
			const udsPath = join(socketsDir, `${socketName}.sock`);
			const yamlPath = join(socketsDir, `${socketName}.yaml`);

			const udsServer = createSocketServer(listener, {
				noDelay: true,
				keepAlive: true,
				keepAliveInitialDelay: 600,
			});

			udsServer.isPerThreadSocket = true;
			// Strip the PROXY v1 header a fronting proxy (e.g. symphony) prepends, same as the
			// HTTP UDS mirror. Without this the header is fed to the protocol parser (e.g. MQTT),
			// corrupting the first packet.
			httpComponent.enableProxyProtocol(udsServer);
			SERVERS[udsPath] = udsServer;
			httpComponent.registerUdsCleanupPaths(udsPath, yamlPath);

			const writeMetadata = () => httpComponent.writeUdsMetadata(yamlPath, options.securePort, socketServer);
			SNICallback.ready.then(writeMetadata);
			socketServer.secureContextsListeners.push(writeMetadata);
		}
	}
	if (options.port) {
		setPortServerMap(options.port, { protocol_name: 'TCP', name: getComponentName() });
		socketServer = createSocketServer(listener, {
			noDelay: true,
			keepAlive: true,
			keepAliveInitialDelay: 600,
		});
		// See the securePort path above: opt out of reusePort only on macOS so every worker can
		// accept connections for this listener elsewhere, and mark it worker-owned.
		if (process.platform === 'darwin') socketServer.noReusePort = true;
		socketServer.dedicatedListener = true;
		SERVERS[options.port] = socketServer;
	}
	return socketServer;
}

// Wire server singletons during the startup phase
onStartup(() => {
	server.socket = onSocket;
});
