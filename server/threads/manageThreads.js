'use strict';

const { Worker, MessageChannel, parentPort, isMainThread, threadId, workerData } = require('worker_threads');
const { PACKAGE_ROOT } = require('../../utility/hdbTerms');
const { join, isAbsolute, extname } = require('path');
const { watch, readdir } = require('fs/promises');
const { totalmem } = require('os');
const hdb_terms = require('../../utility/hdbTerms');
const harper_logger = require('../../utility/logging/harper_logger');
const terms = require('../../utility/hdbTerms');
const MB = 1024 * 1024;
const workers = []; // these are our child workers that we are managing
const connected_ports = []; // these are all known connected worker ports (siblings, children, parents)
const MAX_UNEXPECTED_RESTARTS = 50;
const THREAD_TERMINATION_TIMEOUT = 10000; // threads, you got 10 seconds to die
const RESTART_TYPE = 'restart';
const REQUEST_THREAD_INFO = 'request_thread_info';
const RESOURCE_REPORT = 'resource_report';
const THREAD_INFO = 'thread_info';
const ADDED_PORT = 'added-port';
const ACKNOWLEDGEMENT = 'ack';
let getThreadInfo;

module.exports = {
	startWorker,
	restartWorkers,
	shutdownWorkers,
	workers,
	setMonitorListener,
	onMessageFromWorkers,
	onMessageByType,
	broadcast,
	broadcastWithAcknowledgement,
	setChildListenerByType,
	getWorkerIndex,
	setMainIsWorker,
	restartNumber: workerData?.restartNumber || 1,
};
let isMainWorker;
function getWorkerIndex() {
	return workerData ? workerData.workerIndex : isMainWorker ? 0 : undefined;
}
function setMainIsWorker(isWorker) {
	isMainWorker = isWorker;
}
let childListenerByType = {
	[REQUEST_THREAD_INFO](message, worker) {
		sendThreadInfo(worker);
	},
	[RESOURCE_REPORT](message, worker) {
		recordResourceReport(worker, message);
	},
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
	// (and then limit to their license limit, if they have one)
	let available_memory = process.constrainedMemory?.() || totalmem(); // used constrained memory if it is available
	// and lower than total memory
	available_memory = Math.min(available_memory, totalmem());
	const max_old_memory = Math.max(Math.floor(available_memory / MB / (1 + (options.threadCount || 1) / 4)), 512);
	// Max young memory space (semi-space for scavenger) is 1/128 of max memory (limited to 16-64). For most of our m5
	// machines this will be 64MB (less for t3's). This is based on recommendations from:
	// https://www.alibabacloud.com/blog/node-js-application-troubleshooting-manual---comprehensive-gc-problems-and-optimization_594965
	// https://github.com/nodejs/node/issues/42511
	// https://plaid.com/blog/how-we-parallelized-our-node-service-by-30x/
	const max_young_memory = Math.min(Math.max(max_old_memory >> 7, 16), 64);

	let ports_to_send = [];
	for (let existing_port of connected_ports) {
		let { port1, port2 } = new MessageChannel();
		existing_port.postMessage(
			{
				type: ADDED_PORT,
				port: port1,
			},
			[port1]
		);
		ports_to_send.push(port2);
	}
	if (!extname(path)) path += '.js';
	const worker = new Worker(
		isAbsolute(path) ? path : join(PACKAGE_ROOT, path),
		Object.assign(
			{
				resourceLimits: {
					maxOldGenerationSizeMb: max_old_memory,
					maxYoungGenerationSizeMb: max_young_memory,
				},
				execArgv: ['--enable-source-maps'],
				argv: process.argv.slice(2),
				// pass these in synchronously to the worker so it has them on startup:
				workerData: {
					addPorts: ports_to_send,
					workerIndex: options.workerIndex,
					name: options.name,
					restartNumber: module.exports.restartNumber,
				},
				transferList: ports_to_send,
			},
			options
		)
	);
	addPort(worker, true);
	worker.unexpectedRestarts = options.unexpectedRestarts || 0;
	worker.startCopy = () => {
		// in a shutdown sequence we use overlapping restarts, starting the new thread while waiting for the old thread
		// to die, to ensure there is no loss of service and maximum availability.
		startWorker(path, options);
	};
	worker.on('error', (error) => {
		// log errors, and it also important that we catch errors so we can recover if a thread dies (in a recoverable
		// way)
		console.error('Worker error:', error); // these should be reported directly to users
		harper_logger.error('Worker error:', error);
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
		childListenerByType[message.type]?.(message, worker);
	});
	workers.push(worker);
	startMonitoring();
	if (options.onStarted) options.onStarted(worker); // notify that it is ready
	worker.name = options.name;
	return worker;
}

const OVERLAPPING_RESTART_TYPES = [hdb_terms.THREAD_TYPES.HTTP];

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

async function restartWorkers(name = null, max_workers_down = 2, start_replacement_threads = true) {
	if (isMainThread) {
		// This is here to prevent circular dependencies
		if (start_replacement_threads) {
			const { loadRootComponents } = require('../loadRootComponents');
			await loadRootComponents();
		}

		module.exports.restartNumber++;
		if (max_workers_down < 1) {
			// we accept a ratio of workers, and compute absolute maximum being down at a time from the total number of
			// threads
			max_workers_down = max_workers_down * workers.length;
		}
		let waiting_to_finish = []; // array of workers that we are waiting to restart
		// make a copy of the workers before iterating them, as the workers
		// array will be mutating a lot during this
		for (let worker of workers.slice(0)) {
			if ((name && worker.name !== name) || worker.wasShutdown) continue; // filter by type, if specified
			worker.postMessage({
				restartNumber: module.exports.restartNumber,
				type: hdb_terms.ITC_EVENT_TYPES.SHUTDOWN,
			});
			worker.wasShutdown = true;
			worker.emit('shutdown', {});
			const overlapping = OVERLAPPING_RESTART_TYPES.indexOf(worker.name) > -1;
			let when_done = new Promise((resolve) => {
				// in case the exit inside the thread doesn't timeout, call terminate if necessary
				let timeout = setTimeout(() => worker.terminate(), THREAD_TERMINATION_TIMEOUT * 2).unref();
				worker.on('exit', () => {
					clearTimeout(timeout);
					waiting_to_finish.splice(waiting_to_finish.indexOf(when_done));
					if (!overlapping && start_replacement_threads) worker.startCopy();
					resolve();
				});
			});
			waiting_to_finish.push(when_done);
			if (overlapping && start_replacement_threads) {
				worker.startCopy();
				if (waiting_to_finish.length >= max_workers_down) {
					// wait for one to finish before continuing to restart more
					await Promise.race(waiting_to_finish);
				}
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
	}
}
function setChildListenerByType(type, listener) {
	childListenerByType[type] = listener;
}
function shutdownWorkers(name) {
	return restartWorkers(name, Infinity, false);
}

const message_listeners = [];
function onMessageFromWorkers(listener) {
	message_listeners.push(listener);
}
const listeners_by_type = new Map();
function onMessageByType(type, listener) {
	let listeners = listeners_by_type.get(type);
	if (!listeners) listeners_by_type.set(type, (listeners = []));
	listeners.push(listener);
}

function broadcast(message) {
	for (let port of connected_ports) {
		try {
			port.postMessage(message);
		} catch (error) {
			harper_logger.error(`Unable to send message to worker`, error);
		}
	}
}

const awaiting_responses = new Map();
let next_id = 1;
function broadcastWithAcknowledgement(message) {
	return new Promise((resolve) => {
		let waiting_count = 0;
		for (let port of connected_ports) {
			try {
				let request_id = next_id++;
				const ack_handler = () => {
					awaiting_responses.delete(request_id);
					if (--waiting_count === 0) {
						resolve();
					}
					if (port !== parentPort && --port.refCount === 0) {
						port.unref();
					}
				};
				ack_handler.port = port;
				port.ref();
				port.refCount = (port.refCount || 0) + 1;
				awaiting_responses.set((message.requestId = request_id), ack_handler);
				if (!port.hasAckCloseListener) {
					// just set a single close listener that can clean up all the ack handlers for a port that is closed
					port.hasAckCloseListener = true;
					port.on(port.close ? 'close' : 'exit', () => {
						for (let [, ack_handler] of awaiting_responses) {
							if (ack_handler.port === port) {
								ack_handler();
							}
						}
					});
				}
				port.postMessage(message);
				waiting_count++;
			} catch (error) {
				harper_logger.error(`Unable to send message to worker`, error);
			}
		}
		if (waiting_count === 0) resolve();
	});
}

function sendThreadInfo(target_worker) {
	target_worker.postMessage({
		type: THREAD_INFO,
		workers: getChildWorkerInfo(),
	});
}

function getChildWorkerInfo() {
	let now = Date.now();
	return workers.map((worker) => ({
		threadId: worker.threadId,
		name: worker.name,
		heapTotal: worker.resources?.heapTotal,
		heapUsed: worker.resources?.heapUsed,
		externalMemory: worker.resources?.external,
		arrayBuffers: worker.resources?.arrayBuffers,
		sinceLastUpdate: now - worker.resources?.updated,
		...worker.recentELU,
	}));
}

/** Record update from worker on stats that it self-reports
 *
 * @param worker
 * @param message
 */
function recordResourceReport(worker, message) {
	worker.resources = message;
	// we want to record when this happens so we know if it has reported recently
	worker.resources.updated = Date.now();
}

let monitor_listener;
function setMonitorListener(listener) {
	monitor_listener = listener;
}

const MONITORING_INTERVAL = 1000;
let monitoring = false;
function startMonitoring() {
	if (monitoring) return;
	monitoring = true;
	// we periodically get the event loop utilitization so we have a reasonable time frame to check the recent
	// utilization levels (last second) and so we don't have to make these calls to frequently
	setInterval(() => {
		for (let worker of workers) {
			let current_ELU = worker.performance.eventLoopUtilization();
			let recent_ELU;
			if (worker.lastTotalELU) {
				// get the difference between current and last to determine the last second of utilization
				recent_ELU = worker.performance.eventLoopUtilization(current_ELU, worker.lastTotalELU);
			} else {
				recent_ELU = current_ELU;
			}
			worker.lastTotalELU = current_ELU;
			worker.recentELU = recent_ELU;
		}
		if (monitor_listener) monitor_listener();
	}, MONITORING_INTERVAL).unref();
}
const REPORTING_INTERVAL = 1000;

if (parentPort) {
	addPort(parentPort);
	for (let port of workerData.addPorts) {
		addPort(port);
	}
	setInterval(() => {
		// post our memory usage as a resource report, reporting our memory usage
		let memory_usage = process.memoryUsage();
		parentPort.postMessage({
			type: RESOURCE_REPORT,
			heapTotal: memory_usage.heapTotal,
			heapUsed: memory_usage.heapUsed,
			external: memory_usage.external,
			arrayBuffers: memory_usage.arrayBuffers,
		});
	}, REPORTING_INTERVAL).unref();
	getThreadInfo = () =>
		new Promise((resolve, reject) => {
			// request thread info from the parent thread and wait for it to response with info on all the threads
			parentPort.on('message', receiveThreadInfo);
			parentPort.postMessage({ type: REQUEST_THREAD_INFO });
			function receiveThreadInfo(message) {
				if (message.type === THREAD_INFO) {
					parentPort.off('message', receiveThreadInfo);
					resolve(message.workers);
				}
			}
		});
} else {
	getThreadInfo = getChildWorkerInfo;
}
module.exports.getThreadInfo = getThreadInfo;

function addPort(port, keep_ref) {
	connected_ports.push(port);
	port
		.on('message', (message) => {
			if (message.type === ADDED_PORT) addPort(message.port);
			else if (message.type === ACKNOWLEDGEMENT) {
				let completion = awaiting_responses.get(message.id);
				if (completion) {
					completion();
				}
			} else {
				for (let listener of message_listeners) {
					listener(message, port);
				}
				let listeners = listeners_by_type.get(message.type);
				if (listeners) {
					for (let listener of listeners) {
						try {
							listener(message, port);
						} catch (error) {
							harper_logger.error(error);
						}
					}
				}
			}
		})
		.on('close', () => {
			connected_ports.splice(connected_ports.indexOf(port), 1);
		})
		.on('exit', () => {
			connected_ports.splice(connected_ports.indexOf(port), 1);
		});
	if (keep_ref) port.refCount = 100;
	else port.unref();
}
if (isMainThread) {
	let before_restart, queued_restart;
	const watch_dir = async (dir, before_restart_callback) => {
		if (before_restart_callback) before_restart = before_restart_callback;
		for (let entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) watch_dir(join(dir, entry.name));
		}
		for await (let { filename } of watch(dir, { persistent: false })) {
			if (extname(filename) === '.ts' || extname(filename) === '.js' || extname(filename) === '.graphql') {
				if (queued_restart) clearTimeout(queued_restart);
				queued_restart = setTimeout(async () => {
					if (before_restart) await before_restart();
					await restartWorkers();
					harper_logger.info('Reloaded HarperDB components');
				}, 100);
			}
		}
	};
	module.exports.watchDir = watch_dir;
	if (process.env.WATCH_DIR) watch_dir(process.env.WATCH_DIR);
} else {
	parentPort.on('message', async (message) => {
		const { type } = message;
		if (type === hdb_terms.ITC_EVENT_TYPES.SHUTDOWN) {
			module.exports.restartNumber = message.restartNumber;
			parentPort.unref(); // remove this handle
			setTimeout(() => {
				harper_logger.warn('Thread did not voluntarily terminate', threadId);
				// Note that if this occurs, you may want to use this to debug what is currently running:
				// require('why-is-node-running')();
				process.exit(0);
			}, THREAD_TERMINATION_TIMEOUT).unref(); // don't block the shutdown
		}
	});
}
