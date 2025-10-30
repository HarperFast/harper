import {
	startWorker,
	setMonitorListener,
	setMainIsWorker,
	shutdownWorkers,
	threadsHaveStarted,
} from './manageThreads.js';
import { createServer, Socket } from 'net';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import * as harperLogger from '../../utility/logging/harper_logger.js';
import { unlinkSync, existsSync } from 'fs';
import { recordHostname, recordAction } from '../../resources/analytics/write.ts';
import { isMainThread } from 'worker_threads';
import { packageJson } from '../../utility/packageUtils.js';
import { join } from 'path';

const workers = [];
let queuedSockets = [];
const handleSocket = [];
let directThreadServer;
let currentThreadCount = 0;
const workersReady = [];

if (isMainThread) {
	process.on('uncaughtException', (error) => {
		// TODO: Maybe we should try to log the first of each type of error
		if (error.code === 'ECONNRESET') return; // that's what network connections do
		if (error.code === 'EIO') {
			// that means the terminal is closed
			harperLogger.disableStdio();
			return;
		}
		console.error('uncaughtException', error);
	});
}

export async function startHTTPThreads(threadCount = 2, dynamicThreads?: boolean) {
	recordHostname().catch((err) => harperLogger.error?.('Error recording hostname for analytics:', err));
	try {
		if (dynamicThreads) {
			startHTTPWorker(0, 1, true);
		} else {
			const { loadRootComponents } = require('../loadRootComponents.js');
			if (threadCount === 0) {
				setMainIsWorker(true);
				await require('./threadServer.js').startServers();
				return Promise.resolve([]);
			}
			await loadRootComponents();
		}
		for (let i = 0; i < threadCount; i++) {
			startHTTPWorker(i, threadCount);
		}
		return Promise.all(workersReady);
	} finally {
		threadsHaveStarted();
	}
}

function startHTTPWorker(index, threadCount = 1, shutdownWhenIdle?) {
	currentThreadCount++;
	startWorker(join(__dirname, './threadServer.js'), {
		name: hdbTerms.THREAD_TYPES.HTTP,
		workerIndex: index,
		threadCount,
		async onStarted(worker) {
			// note that this can be called multiple times, once when started, and again when threads are restarted
			const ready = new Promise((resolve, reject) => {
				function onMessage(message) {
					if (message.type === 'child_started') {
						worker.removeListener('message', onMessage);
						resolve(worker);
					}
				}

				worker.on('message', onMessage);
				worker.on('error', reject);
			});
			workersReady.push(ready);
			await ready;
			workers.push(worker);
			worker.expectedIdle = 1;
			worker.lastIdle = 0;
			worker.requests = 1;
			worker.on('message', (message) => {
				if (message.requestId) {
					const handler = requestMap.get(message.requestId);
					if (handler) handler(message);
				}
			});
			worker.on('exit', removeWorker);
			worker.on('shutdown', removeWorker);
			function removeWorker() {
				const index = workers.indexOf(worker);
				if (index > -1) workers.splice(index, 1);
			}
			if (queuedSockets) {
				// if there are any queued sockets, we re-deliver them
				const sockets = queuedSockets;
				queuedSockets = [];
				for (const socket of sockets) handleSocket[socket.localPort](null, socket);
			}
		},
	});
	if (shutdownWhenIdle) {
		const interval = setInterval(() => {
			if (recentRequest) recentRequest = false;
			else {
				clearInterval(interval);
				console.log('shut down dynamic thread due to inactivity');
				shutdownWorkers();
				currentThreadCount = 0;
				setTimeout(() => {
					global.gc?.();
				}, 5000);
			}
		}, 10000);
	}
}
let recentRequest;
export function startSocketServer(port = 0, sessionAffinityIdentifier?) {
	if (typeof port === 'string') {
		// if we are using a unix domain socket, we try to delete it first, otherwise it will throw an EADDRESSINUSE
		// error
		try {
			if (existsSync(port)) unlinkSync(port);
		} catch (error) {}
	}
	// at some point we may want to actually read from the https connections
	let workerStrategy;
	if (sessionAffinityIdentifier) {
		// use remote ip address based session affinity
		if (sessionAffinityIdentifier === 'ip') workerStrategy = findByRemoteAddressAffinity;
		// use a header for session affinity (like Authorization or Cookie)
		else workerStrategy = makeFindByHeaderAffinity(sessionAffinityIdentifier);
	} else workerStrategy = findMostIdleWorker; // no session affinity, just delegate to most idle worker
	const server = createServer({
		allowHalfOpen: true,
		pauseOnConnect: !workerStrategy.readsData,
	}).listen(port);
	if (server._handle) {
		server._handle.onconnection = handleSocket[port] = function (err, clientHandle) {
			if (!workerStrategy.readsData) {
				clientHandle.reading = false;
				clientHandle.readStop();
			}
			recentRequest = true;
			workerStrategy(clientHandle, (worker, receivedData) => {
				if (!worker) {
					if (directThreadServer) {
						const socket = clientHandle._socket || new Socket({ handle: clientHandle, writable: true, readable: true });
						directThreadServer.deliverSocket(socket, port, receivedData);
						socket.resume();
					} else if (currentThreadCount > 0) {
						// should be a thread coming on line
						if (queuedSockets.length === 0) {
							setTimeout(() => {
								if (queuedSockets.length > 0) {
									console.warn(
										'Incoming sockets/requests have been queued for workers to start, and no workers have handled them. Check to make sure an error is not preventing workers from starting'
									);
								}
							}, 10000).unref();
						}
						clientHandle.localPort = port;
						queuedSockets.push(clientHandle);
					} else {
						console.log('start up a dynamic thread to handle request');
						startHTTPWorker(0);
					}
					recordAction(false, 'socket-routed');
					return;
				}
				worker.requests++;
				const fd = clientHandle.fd;
				if (fd >= 0) worker.postMessage({ port, fd, data: receivedData });
				// valid file descriptor, forward it
				// Windows doesn't support passing sockets by file descriptors, so we have manually proxy the socket data
				else {
					const socket = clientHandle._socket || new Socket({ handle: clientHandle, writable: true, readable: true });
					proxySocket(socket, worker, port);
				}
				recordAction(true, 'socket-routed');
			});
		};
		harperLogger.info(`HarperDB ${packageJson.version} Server running on port ${port}`);
	}
	server.on('error', (error) => {
		console.error('Error in socket server', error);
	});
	if (process.env._UNREF_SERVER) server.unref();
	return server;
}

let secondBestAvailability = 0;

/**
 * Delegate to workers based on what worker is likely to be most idle/available.
 * @returns Worker
 */
function findMostIdleWorker(handle, deliver) {
	// fast algorithm for delegating work to workers based on last idleness check (without constantly checking idleness)
	let selectedWorker;
	let lastAvailability = 0;
	for (const worker of workers) {
		if (worker.threadId === -1) continue;
		const availability = worker.expectedIdle / worker.requests;
		if (availability > lastAvailability) {
			selectedWorker = worker;
		} else if (lastAvailability >= secondBestAvailability) {
			secondBestAvailability = availability;
			return deliver(selectedWorker);
		}
		lastAvailability = availability;
	}
	secondBestAvailability = 0;
	deliver(selectedWorker);
}

const AFFINITY_TIMEOUT = 3600000; // an hour timeout
const sessions = new Map();

/**
 * Delegate to workers using session affinity based on remote address. This will send all requests
 * from the same remote address to the same worker.
 * @returns Worker
 */
function findByRemoteAddressAffinity(handle, deliver) {
	const remoteInfo = {};
	handle.getpeername(remoteInfo);
	const address = remoteInfo.address;
	// we might need to fallback to new Socket({handle}).remoteAddress for... bun?
	const entry = sessions.get(address);
	const now = Date.now();
	if (entry && entry.worker.threadId !== -1) {
		entry.lastUsed = now;
		return deliver(entry.worker);
	}
	findMostIdleWorker(handle, (worker) => {
		sessions.set(address, {
			worker,
			lastUsed: now,
		});
		deliver(worker);
	});
}

/**
 * Creates a worker strategy that uses session affinity to maintain the same thread for requests that have the
 * same value of the provided header. You can use a header of "Authorization" for clients that are using
 * basic authentication, or "Cookie" for clients using cookie-based authentication.
 * @param header
 * @returns {findByHeaderAffinity}
 */
function makeFindByHeaderAffinity(header) {
	// regular expression to find the specified header and group match on the value
	const headerExpression = new RegExp(`${header}:\\s*(.+)`, 'i');
	findByHeaderAffinity.readsData = true; // make sure we don't start with the socket being paused
	return findByHeaderAffinity;
	function findByHeaderAffinity(handle, deliver) {
		const socket = new Socket({ handle, readable: true, writable: true });
		handle._socket = socket;
		socket.on('data', (data) => {
			// must forcibly stop the TCP handle to ensure no more data is read and that all further data is read by
			// the child worker thread (once it resumes the socket)
			handle.readStop();
			const headerBlock = data.toString('latin1'); // latin is standard HTTP header encoding and faster
			const headerValue = headerBlock.match(headerExpression)?.[1];
			const entry = sessions.get(headerValue);
			const now = Date.now();
			if (entry && entry.worker.threadId !== -1) {
				entry.lastUsed = now;
				return deliver(entry.worker);
			}

			findMostIdleWorker(handle, (worker) => {
				sessions.set(headerValue, {
					worker,
					lastUsed: now,
				});
				deliver(worker, data);
			});
		});
	}
}

setInterval(() => {
	// clear out expired entries
	const now = Date.now();
	for (const [address, entry] of sessions) {
		if (entry.lastUsed + AFFINITY_TIMEOUT < now) sessions.delete(address);
	}
}, AFFINITY_TIMEOUT).unref();

// basically, the amount of additional idleness to expect based on previous idleness (some work will continue, some
// won't)
const EXPECTED_IDLE_DECAY = 1000;

/**
 * Updates the idleness statistics for each worker
 */
export function updateWorkerIdleness() {
	secondBestAvailability = 0;
	for (const worker of workers) {
		worker.expectedIdle = worker.recentELU.idle + EXPECTED_IDLE_DECAY;
		worker.requests = 1;
	}
	workers.sort((a, b) => (a.expectedIdle > b.expectedIdle ? -1 : 1));
}

setMonitorListener(updateWorkerIdleness);

const requestMap = new Map();
let nextId = 1;

/**
 * Windows does not have file descriptors for sockets and there is no mechanism in NodeJS for sending sockets
 * to workers, so we have to actually read the data from sockets and proxy the data to the threads. We may want
 * to do this for some other types of connections, like cookie-based session affinity at some point, but for now
 * this is just for Windows. This basically listens for the all events on a socket and forwards them to the target
 * worker for it to emulate a socket with the incoming event messages (and vice versa to proxy the response).
 * @param socket
 * @param worker
 * @param type
 */
function proxySocket(socket, worker, port) {
	// socket proxying for Windows
	const requestId = nextId++;
	worker.postMessage({ port, requestId, event: 'connection' });
	socket
		.on('data', (buffer) => {
			const data = buffer.toString('latin1');
			worker.postMessage({ port, requestId, data, event: 'data' });
		})
		.on('close', (hadError) => {
			worker.postMessage({ port, requestId, event: 'close', hadError });
		})
		.on('error', (error) => {
			worker.postMessage({ port, requestId, event: 'error', error });
		})
		.on('drain', (error) => {
			worker.postMessage({ port, requestId, event: 'drain', error });
		})
		.on('end', () => {
			worker.postMessage({ port, requestId, event: 'end' });
		})
		.resume();
	// handle the response
	requestMap.set(requestId, (message) => {
		if (message.event == 'data') socket.write(Buffer.from(message.data, 'latin1'));
		if (message.event == 'end') {
			socket.end(message.data && Buffer.from(message.data, 'latin1'));
			requestMap.delete(requestId);
		}
		if (message.event == 'destroy') {
			socket.destroy();
			requestMap.delete(requestId);
		}
	});
}
