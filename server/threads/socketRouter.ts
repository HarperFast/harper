import {
	startWorker,
	setMonitorListener,
	setMainIsWorker,
	shutdownWorkers,
	onMessageFromWorkers,
	threadsHaveStarted,
} from './manageThreads';
import { createServer, Socket } from 'net';
import * as hdb_terms from '../../utility/hdbTerms';
import * as harper_logger from '../../utility/logging/harper_logger';
import { unlinkSync, existsSync } from 'fs';
import { recordHostname, recordAction } from '../../resources/analytics/write';
import { isMainThread } from 'worker_threads';
import { checkMemoryLimit } from '../../utility/registration/hdb_license';
import { packageJson } from '../../utility/packageUtils';

const workers = [];
let queued_sockets = [];
const handle_socket = [];
let direct_thread_server;
let current_thread_count = 0;
const workers_ready = [];
let license_warning_interval_id;

if (isMainThread) {
	process.on('uncaughtException', (error) => {
		// TODO: Maybe we should try to log the first of each type of error
		if (error.code === 'ECONNRESET') return; // that's what network connections do
		if (error.message === 'write EIO') return; // that means the terminal is closed
		console.error('uncaughtException', error);
	});

	onMessageFromWorkers((message) => {
		if (message.type === hdb_terms.ITC_EVENT_TYPES.RESTART && license_warning_interval_id) {
			clearInterval(license_warning_interval_id);
			licenseWarning();
		}
	});
}

const LICENSE_NAG_PERIOD = 600000; // ten minutes
export async function startHTTPThreads(thread_count = 2, dynamic_threads?: boolean) {
	recordHostname().catch(err => harper_logger.error?.('Error recording hostname for analytics:', err));
	try {
		if (dynamic_threads) {
			startHTTPWorker(0, 1, true);
		} else {
			const { loadRootComponents } = require('../loadRootComponents');
			if (thread_count === 0) {
				setMainIsWorker(true);
				await require('./threadServer').startServers();
				return Promise.resolve([]);
			}
			await loadRootComponents();
		}
		licenseWarning();
		for (let i = 0; i < thread_count; i++) {
			startHTTPWorker(i, thread_count);
		}
		return Promise.all(workers_ready);
	} finally {
		threadsHaveStarted();
	}
}

function licenseWarning() {
	const license_warning = checkMemoryLimit();
	if (license_warning && !process.env.DEV_MODE) {
		console.error(license_warning);
		license_warning_interval_id = setInterval(() => {
			harper_logger.notify(license_warning);
		}, LICENSE_NAG_PERIOD).unref();
	}
}

function startHTTPWorker(index, thread_count = 1, shutdown_when_idle?) {
	current_thread_count++;
	startWorker('server/threads/threadServer.js', {
		name: hdb_terms.THREAD_TYPES.HTTP,
		workerIndex: index,
		threadCount: thread_count,
		async onStarted(worker) {
			// note that this can be called multiple times, once when started, and again when threads are restarted
			const ready = new Promise((resolve, reject) => {
				function onMessage(message) {
					if (message.type === hdb_terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STARTED) {
						worker.removeListener('message', onMessage);
						resolve(worker);
					}
				}

				worker.on('message', onMessage);
				worker.on('error', reject);
			});
			workers_ready.push(ready);
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
			if (queued_sockets) {
				// if there are any queued sockets, we re-deliver them
				const sockets = queued_sockets;
				queued_sockets = [];
				for (const socket of sockets) handle_socket[socket.localPort](null, socket);
			}
		},
	});
	if (shutdown_when_idle) {
		const interval = setInterval(() => {
			if (recent_request) recent_request = false;
			else {
				clearInterval(interval);
				console.log('shut down dynamic thread due to inactivity');
				shutdownWorkers();
				current_thread_count = 0;
				setTimeout(() => {
					global.gc?.();
				}, 5000);
			}
		}, 10000);
	}
}
let recent_request;
export function startSocketServer(port = 0, session_affinity_identifier?) {
	if (typeof port === 'string') {
		// if we are using a unix domain socket, we try to delete it first, otherwise it will throw an EADDRESSINUSE
		// error
		try {
			if (existsSync(port)) unlinkSync(port);
		} catch (error) {}
	}
	// at some point we may want to actually read from the https connections
	let worker_strategy;
	if (session_affinity_identifier) {
		// use remote ip address based session affinity
		if (session_affinity_identifier === 'ip') worker_strategy = findByRemoteAddressAffinity;
		// use a header for session affinity (like Authorization or Cookie)
		else worker_strategy = makeFindByHeaderAffinity(session_affinity_identifier);
	} else worker_strategy = findMostIdleWorker; // no session affinity, just delegate to most idle worker
	const server = createServer({
		allowHalfOpen: true,
		pauseOnConnect: !worker_strategy.readsData,
	}).listen(port);
	if (server._handle) {
		server._handle.onconnection = handle_socket[port] = function (err, client_handle) {
			if (!worker_strategy.readsData) {
				client_handle.reading = false;
				client_handle.readStop();
			}
			recent_request = true;
			worker_strategy(client_handle, (worker, received_data) => {
				if (!worker) {
					if (direct_thread_server) {
						const socket =
							client_handle._socket || new Socket({ handle: client_handle, writable: true, readable: true });
						direct_thread_server.deliverSocket(socket, port, received_data);
						socket.resume();
					} else if (current_thread_count > 0) {
						// should be a thread coming on line
						if (queued_sockets.length === 0) {
							setTimeout(() => {
								if (queued_sockets.length > 0) {
									console.warn(
										'Incoming sockets/requests have been queued for workers to start, and no workers have handled them. Check to make sure an error is not preventing workers from starting'
									);
								}
							}, 10000).unref();
						}
						client_handle.localPort = port;
						queued_sockets.push(client_handle);
					} else {
						console.log('start up a dynamic thread to handle request');
						startHTTPWorker(0);
					}
					recordAction(false, 'socket-routed');
					return;
				}
				worker.requests++;
				const fd = client_handle.fd;
				if (fd >= 0) worker.postMessage({ port, fd, data: received_data });
				// valid file descriptor, forward it
				// Windows doesn't support passing sockets by file descriptors, so we have manually proxy the socket data
				else {
					const socket = client_handle._socket || new Socket({ handle: client_handle, writable: true, readable: true });
					proxySocket(socket, worker, port);
				}
				recordAction(true, 'socket-routed');
			});
		};
		harper_logger.info(`HarperDB ${packageJson.version} Server running on port ${port}`);
	}
	server.on('error', (error) => {
		console.error('Error in socket server', error);
	});
	if (process.env._UNREF_SERVER) server.unref();
	return server;
}

let second_best_availability = 0;

/**
 * Delegate to workers based on what worker is likely to be most idle/available.
 * @returns Worker
 */
function findMostIdleWorker(handle, deliver) {
	// fast algorithm for delegating work to workers based on last idleness check (without constantly checking idleness)
	let selected_worker;
	let last_availability = 0;
	for (const worker of workers) {
		if (worker.threadId === -1) continue;
		const availability = worker.expectedIdle / worker.requests;
		if (availability > last_availability) {
			selected_worker = worker;
		} else if (last_availability >= second_best_availability) {
			second_best_availability = availability;
			return deliver(selected_worker);
		}
		last_availability = availability;
	}
	second_best_availability = 0;
	deliver(selected_worker);
}

const AFFINITY_TIMEOUT = 3600000; // an hour timeout
const sessions = new Map();

/**
 * Delegate to workers using session affinity based on remote address. This will send all requests
 * from the same remote address to the same worker.
 * @returns Worker
 */
function findByRemoteAddressAffinity(handle, deliver) {
	const remote_info = {};
	handle.getpeername(remote_info);
	const address = remote_info.address;
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
	const header_expression = new RegExp(`${header}:\\s*(.+)`, 'i');
	findByHeaderAffinity.readsData = true; // make sure we don't start with the socket being paused
	return findByHeaderAffinity;
	function findByHeaderAffinity(handle, deliver) {
		const socket = new Socket({ handle, readable: true, writable: true });
		handle._socket = socket;
		socket.on('data', (data) => {
			// must forcibly stop the TCP handle to ensure no more data is read and that all further data is read by
			// the child worker thread (once it resumes the socket)
			handle.readStop();
			const header_block = data.toString('latin1'); // latin is standard HTTP header encoding and faster
			const header_value = header_block.match(header_expression)?.[1];
			const entry = sessions.get(header_value);
			const now = Date.now();
			if (entry && entry.worker.threadId !== -1) {
				entry.lastUsed = now;
				return deliver(entry.worker);
			}

			findMostIdleWorker(handle, (worker) => {
				sessions.set(header_value, {
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
	second_best_availability = 0;
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
