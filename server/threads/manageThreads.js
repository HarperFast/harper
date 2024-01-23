'use strict';

const { Worker, MessageChannel, parentPort, isMainThread, threadId, workerData } = require('worker_threads');
const { PACKAGE_ROOT } = require('../../utility/hdbTerms');
const { join, isAbsolute, extname } = require('path');
const { server } = require('../Server');
const { watch, readdir } = require('fs/promises');
const { totalmem } = require('os');
const hdb_terms = require('../../utility/hdbTerms');
const env_mgr = require('../../utility/environment/environmentManager');
const harper_logger = require('../../utility/logging/harper_logger');
const { randomBytes } = require('crypto');
const { _assignPackageExport } = require('../../index');
const terms = require('../../utility/hdbTerms');
const MB = 1024 * 1024;
const workers = []; // these are our child workers that we are managing
const connected_ports = []; // these are all known connected worker ports (siblings, children, parents)
const MAX_UNEXPECTED_RESTARTS = 50;
let thread_termination_timeout = 10000; // threads, you got 10 seconds to die
const RESTART_TYPE = 'restart';
const REQUEST_THREAD_INFO = 'request_thread_info';
const RESOURCE_REPORT = 'resource_report';
const THREAD_INFO = 'thread_info';
const ADDED_PORT = 'added-port';
const ACKNOWLEDGEMENT = 'ack';
let getThreadInfo;
_assignPackageExport('threads', connected_ports);

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
	getWorkerCount,
	getTicketKeys,
	setMainIsWorker,
	setTerminateTimeout,
	restartNumber: workerData?.restartNumber || 1,
};

connected_ports.onMessageByType = onMessageByType;
connected_ports.sendToThread = function (thread_id, message) {
	if (!message?.type) throw new Error('A message with a type must be provided');
	const port = connected_ports.find((port) => port.threadId === thread_id);
	if (port) {
		port.postMessage(message);
		return true;
	}
};

let isMainWorker;
function setTerminateTimeout(new_timeout) {
	thread_termination_timeout = new_timeout;
}
function getWorkerIndex() {
	return workerData ? workerData.workerIndex : isMainWorker ? 0 : undefined;
}
function getWorkerCount() {
	return workerData ? workerData.workerCount : isMainWorker ? 1 : undefined;
}
function setMainIsWorker(isWorker) {
	isMainWorker = isWorker;
}
let worker_count = 1; // should be assigned when workers are created
let ticket_keys;
function getTicketKeys() {
	if (ticket_keys) return ticket_keys;
	ticket_keys = isMainThread ? randomBytes(48) : workerData.ticketKeys;
	return ticket_keys;
}
Object.defineProperty(server, 'workerIndex', {
	get() {
		return getWorkerIndex();
	},
});
Object.defineProperty(server, 'workerCount', {
	get() {
		return getWorkerCount();
	},
});
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
	available_memory = Math.min(available_memory, totalmem(), 20000 * MB);
	const max_old_memory =
		env_mgr.get(hdb_terms.CONFIG_PARAMS.MAXHEAPMEMORY) ??
		Math.max(Math.floor(available_memory / MB / (10 + (options.threadCount || 1) / 4)), 512);
	// Max young memory space (semi-space for scavenger) is 1/128 of max memory (limited to 16-64). For most of our m5
	// machines this will be 64MB (less for t3's). This is based on recommendations from:
	// https://www.alibabacloud.com/blog/node-js-application-troubleshooting-manual---comprehensive-gc-problems-and-optimization_594965
	// https://github.com/nodejs/node/issues/42511
	// https://plaid.com/blog/how-we-parallelized-our-node-service-by-30x/
	const max_young_memory = Math.min(Math.max(max_old_memory >> 6, 16), 64);

	const channels_to_connect = [];
	const ports_to_send = [];
	for (let existing_port of connected_ports) {
		const channel = new MessageChannel();
		channel.existingPort = existing_port;
		channels_to_connect.push(channel);
		ports_to_send.push(channel.port2);
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
					addThreadIds: channels_to_connect.map((channel) => channel.existingPort.threadId),
					workerIndex: options.workerIndex,
					workerCount: (worker_count = options.threadCount),
					name: options.name,
					restartNumber: module.exports.restartNumber,
					ticketKeys: getTicketKeys(),
				},
				transferList: ports_to_send,
			},
			options
		)
	);
	// now that we have the new thread ids, we can finishing connecting the channel and notify the existing
	// worker of the new port with thread id.
	for (let { port1, existingPort: existing_port } of channels_to_connect) {
		existing_port.postMessage(
			{
				type: ADDED_PORT,
				port: port1,
				threadId: worker.threadId,
			},
			[port1]
		);
	}
	addPort(worker, true);
	worker.unexpectedRestarts = options.unexpectedRestarts || 0;
	worker.startCopy = () => {
		// in a shutdown sequence we use overlapping restarts, starting the new thread while waiting for the old thread
		// to die, to ensure there is no loss of service and maximum availability.
		return startWorker(path, options);
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

async function restartWorkers(
	name = null,
	max_workers_down = Math.max(worker_count > 3, 1), // restart 1/8 of the threads at a time, but at least 1
	start_replacement_threads = true
) {
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
		let waiting_to_start = [];
		for (let worker of workers.slice(0)) {
			if ((name && worker.name !== name) || worker.wasShutdown) continue; // filter by type, if specified
			harper_logger.trace('sending shutdown request to ', worker.threadId);
			worker.postMessage({
				restartNumber: module.exports.restartNumber,
				type: hdb_terms.ITC_EVENT_TYPES.SHUTDOWN,
			});
			worker.wasShutdown = true;
			worker.emit('shutdown', {});
			const overlapping = OVERLAPPING_RESTART_TYPES.indexOf(worker.name) > -1;
			let when_done = new Promise((resolve) => {
				// in case the exit inside the thread doesn't timeout, call terminate if necessary
				let timeout = setTimeout(() => worker.terminate(), thread_termination_timeout * 2).unref();
				worker.on('exit', () => {
					clearTimeout(timeout);
					waiting_to_finish.splice(waiting_to_finish.indexOf(when_done));
					if (!overlapping && start_replacement_threads) worker.startCopy();
					resolve();
				});
			});
			waiting_to_finish.push(when_done);
			if (overlapping && start_replacement_threads) {
				let new_worker = worker.startCopy();
				let when_started = new Promise((resolve) => {
					const startListener = (message) => {
						if (message.type === terms.ITC_EVENT_TYPES.CHILD_STARTED) {
							harper_logger.trace('Worker has started', new_worker.threadId);
							resolve();
							waiting_to_start.splice(waiting_to_start.indexOf(when_started));
							new_worker.off('message', startListener);
						}
					};
					harper_logger.trace('Waiting for worker to start', new_worker.threadId);
					new_worker.on('message', startListener);
				});
				waiting_to_start.push(when_started);
				if (waiting_to_finish.length >= max_workers_down) {
					// wait for one to finish before terminating to restart more
					await Promise.race(waiting_to_finish);
				}
				if (waiting_to_start.length >= max_workers_down) {
					// wait for one to finish before starting to restart more
					await Promise.race(waiting_to_start);
				}
			}
		}
		// seems appropriate to wait for this to finish, but the API doesn't actually wait for this function
		// to finish, so not that important
		await Promise.all(waiting_to_finish);
		await Promise.all(waiting_to_start);
		const { restartService } = require('../../bin/restart');
		if (
			start_replacement_threads &&
			(name === 'http' || !name) &&
			env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)
		) {
			await restartService({ service: 'clustering' });
		}
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

const MAX_SYNC_BROADCAST = 10;
async function broadcast(message) {
	let count = 0;
	for (let port of connected_ports) {
		try {
			port.postMessage(message);
			if (count++ > MAX_SYNC_BROADCAST) {
				// posting messages can be somewhat expensive, so we yield the event turn occassionally to not cause any delays.
				count = 0;
				await new Promise(setImmediate);
			}
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
	for (let i = 0, l = workerData.addPorts.length; i < l; i++) {
		let port = workerData.addPorts[i];
		port.threadId = workerData.addThreadIds[i];
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
			if (message.type === ADDED_PORT) {
				message.port.threadId = message.threadId;
				addPort(message.port);
			} else if (message.type === ACKNOWLEDGEMENT) {
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
			if (entry.isDirectory() && entry.name !== 'node_modules') watch_dir(join(dir, entry.name));
		}
		try {
			for await (let { filename } of watch(dir, { persistent: false })) {
				if (queued_restart) clearTimeout(queued_restart);
				queued_restart = setTimeout(async () => {
					if (before_restart) await before_restart();
					await restartWorkers();
					console.log('Reloaded HarperDB components');
				}, 100);
			}
		} catch (error) {
			console.warn('Error trying to watch component directory', dir, error);
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
			}, thread_termination_timeout).unref(); // don't block the shutdown
		}
	});
}
