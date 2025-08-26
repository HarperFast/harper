'use strict';
require('../../bin/dev.js');
const { Worker, MessageChannel, parentPort, isMainThread, threadId, workerData } = require('worker_threads');
const { PACKAGE_ROOT } = require('../../utility/packageUtils.js');
const { join, isAbsolute, extname } = require('path');
const { server } = require('../Server.ts');
const { watch, readdir } = require('fs/promises');
const { totalmem } = require('os');
const hdbTerms = require('../../utility/hdbTerms.ts');
const envMgr = require('../../utility/environment/environmentManager.js');
const harperLogger = require('../../utility/logging/harper_logger.js');
const { randomBytes } = require('crypto');
const { _assignPackageExport } = require('../../globals.js');
const MB = 1024 * 1024;
const workers = []; // these are our child workers that we are managing
const connectedPorts = []; // these are all known connected worker ports (siblings, children, parents)
const MAX_UNEXPECTED_RESTARTS = 50;
let threadTerminationTimeout = 10000; // threads, you got 10 seconds to die
const RESTART_TYPE = 'restart';
const REQUEST_THREAD_INFO = 'request_thread_info';
const RESOURCE_REPORT = 'resource_report';
const THREAD_INFO = 'thread_info';
const ADDED_PORT = 'added-port';
const ACKNOWLEDGEMENT = 'ack';
let getThreadInfo;
let mainThreadPort = parentPort;
_assignPackageExport('threads', connectedPorts);

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

connectedPorts.onMessageByType = onMessageByType;
connectedPorts.sendToThread = function (threadId, message) {
	if (!message?.type) throw new Error('A message with a type must be provided');
	const port = connectedPorts.find((port) => port.threadId === threadId);
	if (port) {
		port.postMessage(message);
		return true;
	}
};
module.exports.whenThreadsStarted = new Promise((resolve) => {
	module.exports.threadsHaveStarted = resolve;
});

let isMainWorker;
function setTerminateTimeout(newTimeout) {
	threadTerminationTimeout = newTimeout;
}
function getWorkerIndex() {
	return workerData ? workerData.workerIndex : isMainWorker ? 0 : undefined;
}
function getWorkerCount() {
	return workerData ? workerData.workerCount : isMainWorker ? 1 : undefined;
}
function setMainIsWorker(isWorker) {
	isMainWorker = isWorker;
	module.exports.threadsHaveStarted();
}
let workerCount = 1; // should be assigned when workers are created
let ticketKeys;
function getTicketKeys() {
	if (ticketKeys) return ticketKeys;
	ticketKeys = isMainThread ? randomBytes(48) : workerData.ticketKeys;
	return ticketKeys;
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
	let availableMemory = process.constrainedMemory?.() || totalmem(); // used constrained memory if it is available
	// and lower than total memory
	availableMemory = Math.min(availableMemory, totalmem(), 20000 * MB);
	const maxOldMemory =
		envMgr.get(hdbTerms.CONFIG_PARAMS.THREADS_MAXHEAPMEMORY) ??
		Math.max(Math.floor(availableMemory / MB / (10 + (options.threadCount || 1) / 4)), 512);
	// Max young memory space (semi-space for scavenger) is 1/128 of max memory (limited to 16-64). For most of our m5
	// machines this will be 64MB (less for t3's). This is based on recommendations from:
	// https://www.alibabacloud.com/blog/node-js-application-troubleshooting-manual---comprehensive-gc-problems-and-optimization594965
	// https://github.com/nodejs/node/issues/42511
	// https://plaid.com/blog/how-we-parallelized-our-node-service-by-30x/
	const maxYoungMemory = Math.min(Math.max(maxOldMemory >> 6, 16), 64);

	const channelsToConnect = [];
	const portsToSend = [];
	for (let existingPort of connectedPorts) {
		const channel = new MessageChannel();
		channel.existingPort = existingPort;
		channelsToConnect.push(channel);
		portsToSend.push(channel.port2);
	}

	if (!extname(path)) path += '.js';

	const worker = new Worker(isAbsolute(path) ? path : join(PACKAGE_ROOT, path), {
		resourceLimits: {
			maxOldGenerationSizeMb: maxOldMemory,
			maxYoungGenerationSizeMb: maxYoungMemory,
		},
		execArgv: [
			'--enable-source-maps',

			// expose Node.js internal utils so jsLoader can use `decorateErrorStack()`
			'--expose-internals'
		],
		argv: process.argv.slice(2),
		// pass these in synchronously to the worker so it has them on startup:
		workerData: {
			addPorts: portsToSend,
			addThreadIds: channelsToConnect.map((channel) => channel.existingPort.threadId),
			workerIndex: options.workerIndex,
			workerCount: (workerCount = options.threadCount),
			name: options.name,
			restartNumber: module.exports.restartNumber,
			ticketKeys: getTicketKeys(),
		},
		transferList: portsToSend,
		...options,
	});
	// now that we have the new thread ids, we can finishing connecting the channel and notify the existing
	// worker of the new port with thread id.
	for (let { port1, existingPort: existingPort } of channelsToConnect) {
		existingPort.postMessage(
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
		harperLogger.error(`Worker index ${options.workerIndex} error:`, error);
	});
	worker.on('exit', (code) => {
		workers.splice(workers.indexOf(worker), 1);
		if (!worker.wasShutdown && options.autoRestart !== false) {
			// if this wasn't an intentional shutdown, restart now (unless we have tried too many times)
			if (worker.unexpectedRestarts < MAX_UNEXPECTED_RESTARTS) {
				options.unexpectedRestarts = worker.unexpectedRestarts + 1;
				startWorker(path, options);
			} else harperLogger.error(`Thread has been restarted ${worker.restarts} times and will not be restarted`);
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

const OVERLAPPING_RESTART_TYPES = [hdbTerms.THREAD_TYPES.HTTP];

/**
 * Restart all the worker threads
 * @param name If there is a specific set of threads that need to be restarted, they can be specified with this
 * parameter
 * @param maxWorkersDown The maximum number of worker threads to restart at once. In restarts, we start new
 * threads at the same time we shutdown new ones. However, we usually want to limit how many we do at once to avoid
 * excessive load and to keep things responsive. This parameter throttles the restarts to minimize load from
 * thread startups.
 * @returns {Promise<void>}
 */

async function restartWorkers(
	name = null,
	maxWorkersDown = Math.max(workerCount > 3, 1), // restart 1/8 of the threads at a time, but at least 1
	startReplacementThreads = true
) {
	if (isMainThread) {
		try {
			// we do this because it is possible for a component to chdir to itself, get re-deployed and then the cwd
			// inode link is invalid and it can cause a lot of problems. But process.cwd() still returns the path, for
			// some reason, so we need to reset it to the correct path.
			process.chdir(process.cwd());
		} catch (e) {
			harperLogger.error('Unable to reestablish current working directory', e);
		}
		// This is here to prevent circular dependencies
		if (startReplacementThreads) {
			const { loadRootComponents } = require('../loadRootComponents.js');
			await loadRootComponents();
		}

		module.exports.restartNumber++;
		if (maxWorkersDown < 1) {
			// we accept a ratio of workers, and compute absolute maximum being down at a time from the total number of
			// threads
			maxWorkersDown = maxWorkersDown * workers.length;
		}
		let waitingToFinish = []; // array of workers that we are waiting to restart
		// make a copy of the workers before iterating them, as the workers
		// array will be mutating a lot during this
		let waitingToStart = [];
		for (let worker of workers.slice(0)) {
			if ((name && worker.name !== name) || worker.wasShutdown) continue; // filter by type, if specified
			harperLogger.trace('sending shutdown request to ', worker.threadId);
			worker.postMessage({
				restartNumber: module.exports.restartNumber,
				type: hdbTerms.ITC_EVENT_TYPES.SHUTDOWN,
			});
			worker.wasShutdown = true;
			worker.emit('shutdown', {});
			const overlapping = OVERLAPPING_RESTART_TYPES.indexOf(worker.name) > -1;
			let whenDone = new Promise((resolve) => {
				// in case the exit inside the thread doesn't timeout, call terminate if necessary
				let timeout = setTimeout(() => {
					harperLogger.warn('Thread did not voluntarily terminate, terminating from the outside', worker.threadId);
					worker.terminate();
				}, threadTerminationTimeout * 2).unref();
				worker.on('exit', () => {
					clearTimeout(timeout);
					waitingToFinish.splice(waitingToFinish.indexOf(whenDone));
					if (!overlapping && startReplacementThreads) worker.startCopy();
					resolve();
				});
			});
			waitingToFinish.push(whenDone);
			if (overlapping && startReplacementThreads) {
				let newWorker = worker.startCopy();
				let whenStarted = new Promise((resolve) => {
					const startListener = (message) => {
						if (message.type === hdbTerms.ITC_EVENT_TYPES.CHILD_STARTED) {
							harperLogger.trace('Worker has started', newWorker.threadId);
							resolve();
							waitingToStart.splice(waitingToStart.indexOf(whenStarted));
							newWorker.off('message', startListener);
						}
					};
					harperLogger.trace('Waiting for worker to start', newWorker.threadId);
					newWorker.on('message', startListener);
				});
				waitingToStart.push(whenStarted);
				if (waitingToFinish.length >= maxWorkersDown) {
					// wait for one to finish before terminating to restart more
					await Promise.race(waitingToFinish);
				}
				if (waitingToStart.length >= maxWorkersDown) {
					// wait for one to finish before starting to restart more
					await Promise.race(waitingToStart);
				}
			}
		}
		// seems appropriate to wait for this to finish, but the API doesn't actually wait for this function
		// to finish, so not that important
		await Promise.all(waitingToFinish);
		await Promise.all(waitingToStart);
		const { restartService } = require('../../bin/restart.js');
		if (
			startReplacementThreads &&
			(name === 'http' || !name) &&
			envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)
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

const messageListeners = [];
function onMessageFromWorkers(listener) {
	messageListeners.push(listener);
}
const listenersByType = new Map();
function onMessageByType(type, listener) {
	let listeners = listenersByType.get(type);
	if (!listeners) listenersByType.set(type, (listeners = []));
	listeners.push(listener);
}

const MAX_SYNC_BROADCAST = 10;
async function broadcast(message, includeSelf) {
	let count = 0;
	for (let port of connectedPorts) {
		try {
			port.postMessage(message);
			if (count++ > MAX_SYNC_BROADCAST) {
				// posting messages can be somewhat expensive, so we yield the event turn occassionally to not cause any delays.
				count = 0;
				await new Promise(setImmediate);
			}
		} catch (error) {
			harperLogger.error(`Unable to send message to worker`, error);
		}
	}
	if (includeSelf) {
		notifyMessageListeners(message, null);
	}
}

const awaitingResponses = new Map();
let nextId = 1;
function broadcastWithAcknowledgement(message) {
	return new Promise((resolve) => {
		let waitingCount = 0;
		for (let port of connectedPorts) {
			try {
				let requestId = nextId++;
				const ackHandler = () => {
					awaitingResponses.delete(requestId);
					if (--waitingCount === 0) {
						resolve();
					}
					if (port !== parentPort && --port.refCount === 0) {
						port.unref();
					}
				};
				ackHandler.port = port;
				port.ref();
				port.refCount = (port.refCount || 0) + 1;
				awaitingResponses.set((message.requestId = requestId), ackHandler);
				if (!port.hasAckCloseListener) {
					// just set a single close listener that can clean up all the ack handlers for a port that is closed
					port.hasAckCloseListener = true;
					port.on(port.close ? 'close' : 'exit', () => {
						for (let [, ackHandler] of awaitingResponses) {
							if (ackHandler.port === port) {
								ackHandler();
							}
						}
					});
				}
				port.postMessage(message);
				waitingCount++;
			} catch (error) {
				harperLogger.error(`Unable to send message to worker`, error);
			}
		}
		if (waitingCount === 0) resolve();
	});
}

function sendThreadInfo(targetWorker) {
	targetWorker.postMessage({
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

let monitorListener;
function setMonitorListener(listener) {
	monitorListener = listener;
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
		if (monitorListener) monitorListener();
	}, MONITORING_INTERVAL).unref();
}
const REPORTING_INTERVAL = 1000;

if (parentPort && workerData?.addPorts) {
	addPort(parentPort);
	for (let i = 0, l = workerData.addPorts.length; i < l; i++) {
		let port = workerData.addPorts[i];
		port.threadId = workerData.addThreadIds[i];
		addPort(port);
	}
	setInterval(() => {
		// post our memory usage as a resource report, reporting our memory usage
		let memoryUsage = process.memoryUsage();
		parentPort.postMessage({
			type: RESOURCE_REPORT,
			heapTotal: memoryUsage.heapTotal,
			heapUsed: memoryUsage.heapUsed,
			external: memoryUsage.external,
			arrayBuffers: memoryUsage.arrayBuffers,
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

function addPort(port, keepRef) {
	connectedPorts.push(port);
	port
		.on('message', (message) => {
			if (message.type === ADDED_PORT) {
				message.port.threadId = message.threadId;
				addPort(message.port);
			} else if (message.type === ACKNOWLEDGEMENT) {
				let completion = awaitingResponses.get(message.id);
				if (completion) {
					completion();
				}
			} else {
				notifyMessageListeners(message, port);
			}
		})
		.on('close', () => {
			connectedPorts.splice(connectedPorts.indexOf(port), 1);
		})
		.on('exit', () => {
			connectedPorts.splice(connectedPorts.indexOf(port), 1);
		});
	if (keepRef) port.refCount = 100;
	else port.unref();
}
function notifyMessageListeners(message, port) {
	for (let listener of messageListeners) {
		listener(message, port);
	}
	let listeners = listenersByType.get(message.type);
	if (listeners) {
		for (let listener of listeners) {
			try {
				listener(message, port);
			} catch (error) {
				harperLogger.error(error);
			}
		}
	}
}
if (isMainThread) {
	let beforeRestart, queuedRestart;
	let changedFiles = new Set();
	const watchDir = async (dir, beforeRestartCallback) => {
		if (beforeRestartCallback) beforeRestart = beforeRestartCallback;
		for (let entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name !== 'node_modules') watchDir(join(dir, entry.name));
		}
		try {
			for await (let { filename } of watch(dir, { persistent: false })) {
				changedFiles.add(filename);
				if (queuedRestart) clearTimeout(queuedRestart);
				queuedRestart = setTimeout(async () => {
					if (beforeRestart) await beforeRestart();
					await restartWorkers();
					console.log('Reloaded HarperDB components, changed files:', Array.from(changedFiles));
					changedFiles.clear();
				}, 100);
			}
		} catch (error) {
			console.warn('Error trying to watch component directory', dir, error);
		}
	};
	module.exports.watchDir = watchDir;
	if (process.env.WATCH_DIR) watchDir(process.env.WATCH_DIR);
} else {
	parentPort.on('message', async (message) => {
		const { type } = message;
		if (type === hdbTerms.ITC_EVENT_TYPES.SHUTDOWN) {
			module.exports.restartNumber = message.restartNumber;
			parentPort.unref(); // remove this handle
			setTimeout(() => {
				harperLogger.warn('Thread did not voluntarily terminate', threadId);
				// Note that if this occurs, you may want to use this to debug what is currently running:
				// require('why-is-node-running')();
				process.exit(0);
			}, threadTerminationTimeout).unref(); // don't block the shutdown
		}
	});
}
