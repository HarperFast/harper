'use strict';
const { startWorker, setMonitorListener } = require('./manage-threads');
const { createServer } = require('net');
const env = require('../../utility/environment/environmentManager');
const hdb_terms = require('../../utility/hdbTerms');
const harper_logger = require('../../utility/logging/harper_logger');
const pjson = require('../../package.json');
const { unlinkSync, existsSync } = require('fs');
const workers = [];
module.exports = {
	startHTTPThreads,
	startSocketServer,
	updateWorkerIdleness,
	mostIdleRouting: findMostIdleWorker,
	remoteAffinityRouting: findByRemoteAddressAffinity,
};
env.initSync();

async function startHTTPThreads(thread_count = 2) {
	let { loadComponentModules } = require('../../bin/load-component-modules');
	await loadComponentModules();
	for (let i = 0; i < thread_count; i++) {
		startWorker('server/threads/thread-http-server.js', {
			name: hdb_terms.THREAD_TYPES.HTTP,
			isFirst: i === 0,
			onStarted(worker) {
				// note that this can be called multiple times, once when started, and again when threads are restarted
				workers[i] = worker;
				worker.expectedIdle = 1;
				worker.lastIdle = 0;
				worker.requests = 1;
				worker.on('message', (message) => {
					if (message.requestId) {
						let handler = requestMap.get(message.requestId);
						if (handler) handler(message);
					}
				});
			}, // when we implement dynamic thread counts, will also have an onFinished
		});
	}
	return workers;
}

function startSocketServer(port = 0, session_affinity_identifier) {
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
	} else
		worker_strategy = findMostIdleWorker; // no session affinity, just delegate to most idle worker
	let server = createServer(
		{
			allowHalfOpen: true,
			pauseOnConnect: !worker_strategy.readsData,
		},
		(socket) => {
			worker_strategy(socket, (worker, received_data) => {
				if (!worker) return harper_logger.error(`No HTTP workers found`);
				worker.requests++;
				let fd = socket._handle.fd;
				if (fd >= 0) worker.postMessage({ port, fd: socket._handle.fd, data: received_data });
				// valid file descriptor, forward it
				// Windows doesn't support passing sockets by file descriptors, so we have manually proxy the socket data
				else proxySocket(socket, worker, port);
			});
		}
	).listen(port);
	harper_logger.info(`HarperDB ${pjson.version} Server running on port ${port}`);
	return server;
}

let second_best_availability = 0;

/**
 * Delegate to workers based on what worker is likely to be most idle/available.
 * @returns Worker
 */
function findMostIdleWorker(socket, deliver) {
	// fast algorithm for delegating work to workers based on last idleness check (without constantly checking idleness)
	let selected_worker;
	let last_availability = 0;
	for (let worker of workers) {
		let availability = worker.expectedIdle / worker.requests;
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
function findByRemoteAddressAffinity(socket, deliver) {
	let address = socket.remoteAddress;
	let entry = sessions.get(address);
	const now = Date.now();
	if (entry) {
		entry.lastUsed = now;
		return deliver(entry.worker);
	}
	findMostIdleWorker(socket, (worker) => {
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
	let header_expression = new RegExp(`${header}:\s*(.+)`, 'i');
	findByHeaderAffinity.readsData = true; // make sure we don't start with the socket being paused
	return findByHeaderAffinity;
	function findByHeaderAffinity(socket, deliver) {
		socket.on('data', (data) => {
			// must forcibly stop the TCP handle to ensure no more data is read and that all further data is read by
			// the child worker thread (once it resumes the socket)
			socket._handle.readStop();
			let header_block = data.toString('latin1'); // latin is standard HTTP header encoding and faster
			let header_value = header_block.match(header_expression)?.[1];
			let entry = sessions.get(header_value);
			const now = Date.now();
			if (entry) {
				entry.lastUsed = now;
				return deliver(entry.worker);
			}

			findMostIdleWorker(socket, (worker) => {
				sessions.set(header_value, {
					worker,
					lastUsed: now,
				});
				deliver(worker, data);
			});
		});
	};
}

setInterval(() => {
	// clear out expired entries
	const now = Date.now();
	for (let [address, entry] of sessions) {
		if (entry.lastUsed + AFFINITY_TIMEOUT < now) sessions.delete(address);
	}
}, AFFINITY_TIMEOUT).unref();

// basically, the amount of additional idleness to expect based on previous idleness (some work will continue, some
// won't)
const EXPECTED_IDLE_DECAY = 1000;

/**
 * Updates the idleness statistics for each worker
 */
function updateWorkerIdleness() {
	second_best_availability = 0;
	for (let worker of workers) {
		worker.expectedIdle = worker.recentELU.idle + EXPECTED_IDLE_DECAY;
		worker.requests = 1;
	}
	workers.sort((a, b) => (a.expectedIdle > b.expectedIdle ? -1 : 1));
}

setMonitorListener(updateWorkerIdleness);

let requestMap = new Map();
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
	let requestId = nextId++;
	worker.postMessage({ port, requestId, event: 'connection' });
	socket
		.on('data', (buffer) => {
			let data = buffer.toString('latin1');
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
