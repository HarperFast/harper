'use strict';

const { Worker, MessageChannel } = require('worker_threads');
const { PACKAGE_ROOT } = require('../../utility/hdbTerms');
const { join } = require('path');
const { totalmem } = require('os');
const hdb_terms = require("../../utility/hdbTerms");
const env = require("../../utility/environment/environmentManager");
const THREAD_COUNT = Math.max(env.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES),
	env.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_CUSTOM_FUNCTION_PROCESSES));
const MB = 1024 * 1024;
const workers = [];

module.exports = {
	startWorker,
};

function startWorker(path, options = {}) {
	// Take a percentage of total memory to determine the max memory for each thread. The percentage is based
	// on the thread count. Generally, it is unrealistic to efficiently use the majority of total memory for a single
	// NodeJS worker since it would lead to massive swap space usage with other processes and there is significant
	// amount of total memory that is and must be used for disk (heavily used by LMDB).
	// Examples of how much we specify as the maximum memory (for old space):
	// 1 thread: 80% of total memory
	// 4 threads: 50% of total memory per thread
	// 16 threads: 20% of total memory per thread
	// 64 threads: 11% of total memory per thread
	const max_memory = Math.max(Math.floor(totalmem() / MB / (1 + THREAD_COUNT / 4)), 512);
	// Max young memory space (semi-space for scavenger) is 1/128 of max memory. For most of our m5 machines this will be
	// 64MB (less for t3's). This is based on recommendations from:
	// https://www.alibabacloud.com/blog/node-js-application-troubleshooting-manual---comprehensive-gc-problems-and-optimization_594965
	// https://github.com/nodejs/node/issues/42511
	// https://plaid.com/blog/how-we-parallelized-our-node-service-by-30x/
	const max_young_memory = Math.min(Math.max(max_memory >> 7, 16), 64);

	const worker = new Worker(join(PACKAGE_ROOT, path), Object.assign({
		maxOldGenerationSizeMb: max_memory,
		maxYoungGenerationSizeMb: max_young_memory,
	}, options));
	worker.on('error', (error) => {
		console.error('error', error);
	});
	worker.on('exit', (code, message) => {
		if (code !== 0) console.error(`Worker stopped with exit code ${code}` + message);
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
	return worker;
}