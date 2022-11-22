'use strict';

const { Worker, MessageChannel, parentPort, isMainThread } = require('worker_threads');
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
const workers = [];
const MAX_UNEXPECTED_RESTARTS = 50;
const RESTART_TYPE = 'restart';

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
	// Max young memory space (semi-space for scavenger) is 1/128 of max memory. For most of our m5 machines this will be
	// 64MB (less for t3's). This is based on recommendations from:
	// https://www.alibabacloud.com/blog/node-js-application-troubleshooting-manual---comprehensive-gc-problems-and-optimization_594965
	// https://github.com/nodejs/node/issues/42511
	// https://plaid.com/blog/how-we-parallelized-our-node-service-by-30x/
	const max_young_memory = Math.min(Math.max(max_old_memory >> 7, 16), 64);

	const worker = new Worker(isAbsolute(path) ? path : join(PACKAGE_ROOT, path), Object.assign({
		resourceLimits: {
			maxOldGenerationSizeMb: max_old_memory,
			maxYoungGenerationSizeMb: max_young_memory,
		},
	}, options));
	worker.unexpectedRestarts = options.unexpectedRestarts || 0;
	worker.on('requested-shutdown', () => {
		// in a shutdown sequence we use overlapping restarts, starting the new thread while waiting for the old thread
		// to die, to ensure there is no loss of service and maximum availability.
		startWorker(path, options);
	});
	worker.on('error', (error) => {
		// log errors, and it also important that we catch errors so we can recover if a thread dies (in a recoverable
		// way)
		harper_logger.error(error);
	});
	worker.on('exit', (code) => {
		workers.splice(workers.indexOf(worker), 1);
		if (!worker.wasShutdown) {
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
	for (let prevWorker of workers) {
		let { port1, port2 } = new MessageChannel();
		prevWorker.postMessage({
			type: hdb_terms.IPC_EVENT_TYPES.ADD_PORT,
			port: port1,
		}, [port1]);
		worker.postMessage({
			type: hdb_terms.IPC_EVENT_TYPES.ADD_PORT,
			port: port2,
		}, [port2]);
	}
	workers.push(worker);
	options.onStarted(worker); // notify that it is ready
	worker.type = options.type;
	return worker;
}

let restartWorkers;
/**
 * Restart all the worker threads
 * @param max_workers_starting The maximum number of worker threads to restart at once. This allows for "rolling
 * restarts" where we can throttle the restarts to minimize load from thread startups.
 * @returns {Promise<void>}
 */
if (isMainThread) {
	restartWorkers = async function (type, max_workers_down = 2) {
		if (max_workers_down < 1) {
			// we accept a ratio of workers, and compute absolute maximum being down at a time from the total number of
			// threads
			max_workers_down = max_workers_down * workers.length;
		}
		let waiting_to_finish = []; // array of workers that we are waiting to restart
		// make a copy of the workers before iterating them, as the workers
		// array will be mutating a lot during this
		for (let worker of workers.slice(0)) {
			if (type && worker.type !== type) continue; // filter by type, if specified
			worker.postMessage({
				type: hdb_terms.IPC_EVENT_TYPES.SHUTDOWN,
			});
			worker.wasShutdown = true;
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
	};
} else {
	restartWorkers = async function (type) {
		parentPort.postMessage({
			type: RESTART_TYPE,
			workerType: type,
		});
	};
}
module.exports = {
	startWorker,
	restartWorkers,
};

