'use strict';
const {startWorker} = require('./start');
const {createServer} = require('net');
const env = require('../../utility/environment/environmentManager');
const hdb_terms = require('../../utility/hdbTerms');
const harper_logger = require('../../utility/logging/harper_logger');
const pjson = require("../../package.json");
module.exports = {
	startHTTPThreads,
	startSocketServer,
};
const workers = [];
env.initSync();
const THREAD_COUNT = Math.max(env.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES),
	env.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_CUSTOM_FUNCTION_PROCESSES));
const REMOTE_ADDRESS_AFFINITY = env.get(hdb_terms.HDB_SETTINGS_NAMES.HTTP_REMOTE_ADDRESS_AFFINITY);

function startHTTPThreads() {
	for (let i = 0; i < THREAD_COUNT; i++) {
		startWorker('server/threads/thread-http-server.js', {
			type: 'http',
			onStarted(worker) {
				// note that this can be called multiple times, once when started, and again when threads are restarted
				workers[i] = worker;
				worker.expectedIdle = 1;
				worker.requests = 1;
			}, // when we implement dynamic thread counts, will also have an onFinished
		});
	}
}

function startSocketServer(type, port) {
	let workerStrategy = REMOTE_ADDRESS_AFFINITY ? findByRemoteAddressAffinity : findMostIdleWorker;
	// at some point we may want to actually read from the https connections
	createServer({
		allowHalfOpen: true,
		pauseOnConnect: true,
	}, (socket) => {
		const worker = workerStrategy(socket);
		worker.requests++;
		worker.postMessage({ type, fd: socket._handle.fd });
	}).listen(port);
	harper_logger.info(`HarperDB ${pjson.version} Server running on port ${port}`);
}

let second_best_availability = 0;

/**
 * Delegate to workers based on what worker is likely to be most idle/available.
 * @returns Worker
 */
function findMostIdleWorker() {
	// fast algorithm for delegating work to workers based on last idleness check (without constantly checking idleness)
	let selected_worker;
	let last_availability = 0;
	for (let worker of workers) {
		let availability = worker.expectedIdle / worker.requests;
		if (availability > last_availability) {
			selected_worker = worker;
		} else if (last_availability >= second_best_availability) {
			second_best_availability = availability;
			return selected_worker;
		}
		last_availability = availability;
	}
	second_best_availability = 0;
	return selected_worker;
}

const AFFINITY_TIMEOUT = 3600000; // an hour timeout
const remoteAddresses = new Map();

/**
 * Delegate to workers using session affinity based on remote address. This will send all requests
 * from the same remote address to the same worker.
 * @returns Worker
 */
function findByRemoteAddressAffinity(socket) {
	let address = socket.remoteAddress;
	let entry = remoteAddresses.get(address);
	const now = Date.now();
	if (entry) {
		entry.lastUsed = now;
		return entry.worker;
	}
	const worker = findMostIdleWorker();
	remoteAddresses.set(address, {
		worker,
		lastUsed: now,
	});
	return worker;
}

setInterval(() => {
	// clear out expired entries
	const now = Date.now();
	for (let [address, entry] of remoteAddresses) {
		if (entry.lastUsed + AFFINITY_TIMEOUT < now) remoteAddresses.delete(address);
	}
}, AFFINITY_TIMEOUT).unref();

const EXPECTED_IDLE_DECAY = 1000;

/**
 * Updates the idleness statistics for each worker
 */
function updateWorkerIdleness() {
	second_best_availability = 0;
	for (let worker of workers) {
		let idle = worker.performance.eventLoopUtilization().idle;
		worker.expectedIdle = idle - (worker.lastIdle || 0) + EXPECTED_IDLE_DECAY;
		worker.lastIdle = idle;
		worker.requests = 1;
	}
	workers.sort((a, b) => a.expectedIdle > b.expectedIdle ? -1 : 1);
}

setInterval(updateWorkerIdleness, 1000).unref();