'use strict';

const { isMainThread, parentPort, threadId, workerData } = require('node:worker_threads');
const { createServer: createSocketServer } = require('node:net');
const { unlinkSync, existsSync } = require('fs');
let componentsLoadedResolve;
exports.whenComponentsLoaded = new Promise((resolve) => {
	componentsLoadedResolve = resolve;
});

const harperLogger = require('../../utility/logging/harper_logger.js');
const env = require('../../utility/environment/environmentManager.js');
const terms = require('../../utility/hdbTerms.ts');
const { server } = require('../Server.ts');
let { createServer: createSecureSocketServer } = require('node:tls');
const { restartNumber, getWorkerIndex } = require('./manageThreads.js');
const { createReuseportFd } = require('../serverHelpers/Request.ts');
const { createTLSSelector } = require('../../security/keys.js');
const { resolvePath } = require('../../config/configUtils.js');
const { startupLog } = require('../../bin/run.js');
const { SERVERS, setPortServerMap, portServer } = require('../serverRegistry.ts');
const httpComponent = require('../http.ts');
const globals = require('../../globals.js');

const debugThreads = env.get(terms.CONFIG_PARAMS.THREADS_DEBUG);
const sessionAffinity = env.get(terms.CONFIG_PARAMS.HTTP_SESSIONAFFINITY);
server.socket = onSocket;

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
	harperLogger.error('uncaughtException', error);
});
const { HDB_SETTINGS_NAMES, CONFIG_PARAMS } = terms;
env.initSync();
exports.globals = globals;
exports.listenOnPorts = listenOnPorts;
exports.startServers = startServers;

function startServers() {
	const rootPath = env.get(terms.CONFIG_PARAMS.ROOTPATH);
	if (rootPath) {
		try {
			process.chdir(rootPath);
		} catch (error) {
			// ignore any errors with this; just a best effort for now
		}
	}
	let loaded = require('../loadRootComponents.js')
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
						httpComponent.proxyRequest(message);
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
		});
	componentsLoadedResolve(loaded);
	return loaded;
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
