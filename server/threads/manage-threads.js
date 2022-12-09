'use strict';

const { Worker, MessageChannel, parentPort, isMainThread, threadId, workerData } = require('worker_threads');
const { PACKAGE_ROOT } = require('../../utility/hdbTerms');
const { join, isAbsolute } = require('path');
const { totalmem } = require('os');
const hdb_terms = require("../../utility/hdbTerms");
const env = require("../../utility/environment/environmentManager");
const hdb_license = require("../../utility/registration/hdb_license");
const harper_logger = require('../../utility/logging/harper_logger');
const THREAD_COUNT = Math.max(env.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES),
	env.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_CUSTOM_FUNCTION_PROCESSES));
const MB = 1024 * 1024;
const workers = []; // these are our child workers that we are managing
const connected_ports = []; // these are all known connected worker ports (siblings, children, parents)
const MAX_UNEXPECTED_RESTARTS = 50;
const RESTART_TYPE = 'restart';
const ADDED_PORT = 'added-port';

module.exports = {
	startWorker,
	restartWorkers,
	shutdownWorkers,
	workers,
	onMessageFromWorkers,
	broadcast,
};

function startWorker(path, options = {}) {
	const license = hdb_license.licenseSearch();
	const licensed_memory = license.ram_allocation;
	// Take a percentage of total memory to determine the max memory for each thread. The percentage is based
	// on the thread count. Generally, it is unrealistic to efficiently use the majority of total memory for a single
	// NodeJS worker since it would lead to massive swap space usage with other processes and there is significant
	// amount of total memory that is and must be used for disk (heavily used by LMDB).
	// Examples of how much we specify as the maximum memory (for old space):
	// 1 thread: 80% of total memory
	// 4 threads: 50% of total memory per thread
	// 16 threads: 20% of total memory per thread
	// 64 threads: 11% of total memory per thread
	// (and then limit to their license limit, if they have one)
	const max_old_memory = Math.min(Math.max(Math.floor(totalmem() / MB / (1 + THREAD_COUNT / 4)), 512), licensed_memory || Infinity);
	// Max young memory space (semi-space for scavenger) is 1/128 of max memory (limited to 16-64). For most of our m5
	// machines this will be 64MB (less for t3's). This is based on recommendations from:
	// https://www.alibabacloud.com/blog/node-js-application-troubleshooting-manual---comprehensive-gc-problems-and-optimization_594965
	// https://github.com/nodejs/node/issues/42511
	// https://plaid.com/blog/how-we-parallelized-our-node-service-by-30x/
	const max_young_memory = Math.min(Math.max(max_old_memory >> 7, 16), 64);

	let ports_to_send = [];
	for (let existing_port of connected_ports) {
		let { port1, port2 } = new MessageChannel();
		existing_port.postMessage({
			type: ADDED_PORT,
			port: port1,
		}, [port1]);
		ports_to_send.push(port2);
	}

	const worker = new Worker(isAbsolute(path) ? path : join(PACKAGE_ROOT, path), Object.assign({
		resourceLimits: {
			maxOldGenerationSizeMb: max_old_memory,
			maxYoungGenerationSizeMb: max_young_memory,
		},
		argv: process.argv.slice(2),
		workerData: { addPorts: ports_to_send }, // pass these in synchronously to the worker so it has them on startup
		transferList: ports_to_send,
	}, options));
	addPort(worker);
	worker.unexpectedRestarts = options.unexpectedRestarts || 0;
	worker.on('requested-shutdown', () => {
		// in a shutdown sequence we use overlapping restarts, starting the new thread while waiting for the old thread
		// to die, to ensure there is no loss of service and maximum availability.
		if (worker.restart !== false) startWorker(path, options);
	});
	worker.on('error', (error) => {
		// log errors, and it also important that we catch errors so we can recover if a thread dies (in a recoverable
		// way)
		console.error(error);
		harper_logger.error(error);
	});
	worker.on('exit', (code) => {
		workers.splice(workers.indexOf(worker), 1);
		if (!worker.wasShutdown && options.autoRestart !== false) {
			// if this wasn't an intentional shutdown, restart now (unless we have tried too many times)
			if (worker.unexpectedRestarts < MAX_UNEXPECTED_RESTARTS) {
				options.unexpectedRestarts = worker.unexpectedRestarts + 1;
				startWorker(path, options);
			} else harper_logger.error(`Thread has been restarted ${worker.restarts} times and will not be restarted`);
		}
	});
	worker.on('message', (message) => {
		if (message.type === RESTART_TYPE) restartWorkers(message.workerType);
	});
	workers.push(worker);
	if (options.onStarted)
		options.onStarted(worker); // notify that it is ready
	worker.name = options.name;
	return worker;
}

/**
 * Restart all the worker threads
 * @param name If there is a specific set of threads that need to be restarted, they can be specified with this
 * parameter
 * @param max_workers_down The maximum number of worker threads to restart at once. In restarts, we start new
 * threads at the same time we shutdown new ones. However, we usually want to limit how many we do at once to avoid
 * excessive load and to keep things responsive. This parameter throttles the restarts to minimize load from
 * thread startups.
 * @returns {Promise<void>}
 */

async function restartWorkers(name, max_workers_down = 2, start_replacement_threads = true) {
	if (isMainThread) {
		if (max_workers_down < 1) {
			// we accept a ratio of workers, and compute absolute maximum being down at a time from the total number of
			// threads
			max_workers_down = max_workers_down * workers.length;
		}
		let waiting_to_finish = []; // array of workers that we are waiting to restart
		// make a copy of the workers before iterating them, as the workers
		// array will be mutating a lot during this
		for (let worker of workers.slice(0)) {
			if (name && worker.name !== name) continue; // filter by type, if specified
			worker.postMessage({
				type: hdb_terms.IPC_EVENT_TYPES.SHUTDOWN,
			});
			worker.wasShutdown = true;
			worker.restart = start_replacement_threads;
			let when_done = new Promise((resolve) => {
				worker.on('exit', () => {
					waiting_to_finish.splice(waiting_to_finish.indexOf(when_done));
					resolve();
				});
			});
			waiting_to_finish.push(when_done);
			worker.emit('requested-shutdown', {});
			if (waiting_to_finish.length >= max_workers_down) {
				// wait for one to finish before continuing to restart more
				await Promise.race(waiting_to_finish);
			}
		}
		// seems appropriate to wait for this to finish, but the API doesn't actually wait for this function
		// to finish, so not that important
		await Promise.all(waiting_to_finish);
	} else {
		parentPort.postMessage({
			type: RESTART_TYPE,
			workerType: name,
		});
	};
}

function shutdownWorkers(name) {
	return restartWorkers(name, Infinity, false);
}

const message_listeners = [];
function onMessageFromWorkers(listener) {
	message_listeners.push(listener);
}
function broadcast(message) {
	for (let port of connected_ports) {
		try {
			port.postMessage(message);
		} catch(error) {
			harper_logger.error(`Unable to send message to worker`, error);
		}
	}
}

if (parentPort) {
	addPort(parentPort);
	for (let port of workerData.addPorts) {
		addPort(port);
	}
}
function addPort(port) {
	connected_ports.push(port);
	port.on('message', (message) => {
		if (message.type === ADDED_PORT) {
			addPort(message.port);
		} else {
			for (let listener of message_listeners) {
				listener(message);
			}
		}
	}).on('close', () => {
		connected_ports.splice(connected_ports.indexOf(port), 1);
	}).on('exit', () => {
		connected_ports.splice(connected_ports.indexOf(port), 1);
	}).unref();
}
