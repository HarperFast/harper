// Must run before any component code is loaded so that process.exit() called
// from component code (e.g. Next.js's `unhandledRejection` handler) is
// intercepted in workers.
import { realExit } from './workerProcessGuard.ts';
import { Worker, MessageChannel, parentPort, isMainThread, threadId, workerData } from 'worker_threads';
import { onStartup } from '../../utility/lifecycle.ts';
import { join, isAbsolute, extname } from 'path';
import { server } from '../Server.ts';
import { totalmem } from 'os';
import { resetRestartNeeded } from '../../components/requestRestart.ts';
import { loadRootComponents } from '../loadRootComponents.ts';
import { setHeapSnapshotNearHeapLimit as _setHeapSnapshotNearHeapLimit } from 'node:v8';
var setHeapSnapshotNearHeapLimit = typeof globalThis.Bun !== 'undefined' ? () => {} : _setHeapSnapshotNearHeapLimit;
import * as hdbTerms from '../../utility/hdbTerms.ts';
import * as envMgr from '../../utility/environment/environmentManager.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import { randomBytes } from 'crypto';
import { _assignPackageExport } from '../../globals.js';
import { RUNTIME_SRC_ROOT, RUNTIME_FILE_EXT } from '../../utility/packageUtils.js';
import chokidar from 'chokidar';
var isBun = typeof globalThis.Bun !== 'undefined';
var MB = 1024 * 1024;
var workers: any[] = []; // these are our child workers that we are managing
var connectedPorts: any[] = []; // these are all known connected worker ports (siblings, children, parents)
var MAX_UNEXPECTED_RESTARTS = 50;
var threadTerminationTimeout = 10000; // threads, you got 10 seconds to die
var RESTART_TYPE = 'restart';
var REQUEST_THREAD_INFO = 'request_thread_info';
var RESOURCE_REPORT = 'resource_report';
var THREAD_INFO = 'thread_info';
var ADDED_PORT = 'added-port';
var ACKNOWLEDGEMENT = 'ack';
var REMOVE_PORT = 'remove-port';
var FORCE_EXIT = 'force-exit';
var getThreadInfo;
_assignPackageExport('threads', connectedPorts);

var listenersByType = new Map();
var messagesQueuedByType = new Map();
var messageListeners = [];

export let restartNumber = workerData?.restartNumber || 1;
export {
	startWorker,
	restartWorkers,
	shutdownWorkers,
	shutdownWorkersNow,
	workers,
	setMonitorListener,
	onMessageFromWorkers,
	onMessageByType,
	broadcast,
	broadcastWithAcknowledgement,
	getWorkerIndex,
	getWorkerCount,
	getTicketKeys,
	setMainIsWorker,
	setTerminateTimeout,
};

(connectedPorts as any).onMessageByType = onMessageByType;
(connectedPorts as any).sendToThread = function (threadId, message) {
	if (!message?.type) throw new Error('A message with a type must be provided');
	const port = connectedPorts.find((port) => port.threadId === threadId);
	if (!port) return false;
	try {
		port.postMessage(message);
		return true;
	} catch (err) {
		// Port may have closed between find() and postMessage() — treat as unreachable.
		// Only swallow the documented "closed port" race; let serialization bugs
		// (DataCloneError) and other unexpected errors surface to the caller.
		if (err?.code === 'ERR_CLOSED_MESSAGE_PORT') return false;
		throw err;
	}
};
export let threadsHaveStarted: (value?: unknown) => void;
export const whenThreadsStarted = new Promise((resolve) => {
	threadsHaveStarted = resolve;
});

// make sure this is set on all threads, including the main thread (this is no-op
// if it was already with the execArgv below)
if (envMgr.get(hdbTerms.CONFIG_PARAMS.THREADS_HEAPSNAPSHOTNEARLIMIT)) setHeapSnapshotNearHeapLimit(1);

var isMainWorker;
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
	threadsHaveStarted();
}
var workerCount = 1; // should be assigned when workers are created
var ticketKeys;
function getTicketKeys() {
	if (ticketKeys) return ticketKeys;
	ticketKeys = isMainThread ? randomBytes(48) : workerData.ticketKeys;
	return ticketKeys;
}
onStartup(() => {
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
	if (!parentPort) {
		onMessageByType(REQUEST_THREAD_INFO, (message, worker) => {
			if (worker) sendThreadInfo(worker);
		});
		onMessageByType(RESOURCE_REPORT, (message, worker) => {
			if (worker) recordResourceReport(worker, message);
		});
	}
});
// postMessage type listeners that are registered in other ways or can be registered later
listenersByType.set(hdbTerms.ITC_EVENT_TYPES.CHILD_STARTED, null);
listenersByType.set(hdbTerms.ITC_EVENT_TYPES.SCHEMA, null);
listenersByType.set(hdbTerms.ITC_EVENT_TYPES.USER, null);
listenersByType.set(hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST, null);
listenersByType.set(hdbTerms.ITC_EVENT_TYPES.RESOURCE_OPENAPI_REQUEST, null);
listenersByType.set(hdbTerms.ITC_EVENT_TYPES.RESOURCE_OPENAPI_RESPONSE, null);

function startWorker(path, options: any = {}) {
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
		const channel: any = new MessageChannel();
		channel.existingPort = existingPort;
		channelsToConnect.push(channel);
		portsToSend.push(channel.port2);
	}

	// If the caller passed an extensionless module identifier, pick the
	// extension that matches the current execution mode (.ts in typestrip
	// source mode, .js in dist).
	if (!extname(path)) path += RUNTIME_FILE_EXT;

	const isBun = typeof globalThis.Bun !== 'undefined';
	const execArgv = isBun
		? []
		: [
				'--enable-source-maps',
				'--experimental-vm-modules', // used for giving applications their own top level scope
				'--disable-warning=ExperimentalWarning', // yeah, yeah, we know it is experimental
				'--expose-internals', // expose Node.js internal utils so jsLoader can use `decorateErrorStack()`
			];
	if (!isBun && envMgr.get(hdbTerms.CONFIG_PARAMS.THREADS_HEAPSNAPSHOTNEARLIMIT))
		execArgv.push('--heapsnapshot-near-heap-limit=1');

	const worker: any = new Worker(isAbsolute(path) ? path : join(RUNTIME_SRC_ROOT, path), {
		resourceLimits: {
			maxOldGenerationSizeMb: maxOldMemory,
			maxYoungGenerationSizeMb: maxYoungMemory,
		},
		execArgv,
		argv: process.argv.slice(2),
		// pass these in synchronously to the worker so it has them on startup:
		workerData: {
			addPorts: portsToSend,
			addThreadIds: channelsToConnect.map((channel) => channel.existingPort.threadId),
			workerIndex: options.workerIndex,
			workerCount: (workerCount = options.threadCount),
			name: options.name,
			restartNumber: restartNumber,
			ticketKeys: getTicketKeys(),
		},
		transferList: portsToSend,
		...options,
	});
	// now that we have the new thread ids, we can finishing connecting the channel and notify the existing
	// worker of the new port with thread id.
	for (let { port1, existingPort } of channelsToConnect) {
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
	worker.on('exit', (_code) => {
		workers.splice(workers.indexOf(worker), 1);
		if (!worker.wasShutdown && options.autoRestart !== false) {
			// if this wasn't an intentional shutdown, restart now (unless we have tried too many times)
			if (worker.unexpectedRestarts < MAX_UNEXPECTED_RESTARTS) {
				options.unexpectedRestarts = worker.unexpectedRestarts + 1;
				startWorker(path, options);
			} else harperLogger.error(`Thread has been restarted ${worker.restarts} times and will not be restarted`);
		}
	});
	workers.push(worker);
	startMonitoring();
	if (options.onStarted) options.onStarted(worker); // notify that it is ready
	worker.name = options.name;
	return worker;
}

var OVERLAPPING_RESTART_TYPES = [hdbTerms.THREAD_TYPES.HTTP];

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
	maxWorkersDown = Math.max(Math.floor(workerCount / 8), 1), // restart 1/8 of the threads at a time, but at least 1
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
		// problematic cyclic dependency, bind late
		resetRestartNeeded();
		// This is here to prevent circular dependencies
		if (startReplacementThreads) {
			await loadRootComponents();
		}

		restartNumber++;
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
				restartNumber: restartNumber,
				type: hdbTerms.ITC_EVENT_TYPES.SHUTDOWN,
			});
			worker.wasShutdown = true;
			worker.emit('shutdown', {});
			const overlapping = OVERLAPPING_RESTART_TYPES.indexOf(worker.name) > -1;
			let whenDone = new Promise<void>((resolve) => {
				// in case the exit inside the thread doesn't timeout, force it from the outside
				let timeout = setTimeout(() => {
					harperLogger.warn('Thread did not voluntarily terminate, terminating from the outside', worker.threadId);
					if (isBun) {
						// worker.terminate() triggers a NAPI segfault in Bun; ask the worker to self-exit instead
						try {
							worker.postMessage({ type: FORCE_EXIT });
						} catch {}
					} else {
						worker.terminate();
					}
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
				let whenStarted = new Promise<void>((resolve) => {
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
	} else {
		parentPort.postMessage({
			type: RESTART_TYPE,
			workerType: name,
		});
	}
}
function shutdownWorkers(name) {
	return restartWorkers(name, Infinity, false);
}
async function shutdownWorkersNow(name?) {
	shutdownWorkers(name); // set the state of all the workers to shut down. this should finish the important stuff synchronously
	if (isBun) {
		// worker.terminate() triggers a NAPI segfault in Bun; ask workers to self-exit instead
		workers.forEach((worker) => {
			try {
				worker.postMessage({ type: FORCE_EXIT });
			} catch {}
		});
	} else {
		await Promise.all(workers.map((worker) => worker.terminate()));
	}
}

function onMessageFromWorkers(listener) {
	if (!messageListeners) messageListeners = [];
	messageListeners.push(listener);
}
function onMessageByType(type, listener) {
	if (!listenersByType) listenersByType = new Map();
	if (!messagesQueuedByType) messagesQueuedByType = new Map();
	let listeners = listenersByType.get(type);
	if (!listeners) listenersByType.set(type, (listeners = []));
	listeners.push(listener);
	if (messagesQueuedByType.has(type)) {
		for (let message of messagesQueuedByType.get(type)) {
			// enqueue in next event turn; messages always come as events, and trying to do this synchronously can be
			// problematic for getting mixed up with module loading
			setImmediate(() => listener(message));
		}
		messagesQueuedByType.delete(type);
	}
}

var MAX_SYNC_BROADCAST = 10;
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

var awaitingResponses = new Map();
var nextId = 1;
function broadcastWithAcknowledgement(message) {
	return new Promise<void>((resolve) => {
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

var monitorListener;
function setMonitorListener(listener) {
	monitorListener = listener;
}

var MONITORING_INTERVAL = 1000;
var monitoring = false;
function startMonitoring() {
	if (monitoring) return;
	monitoring = true;
	// we periodically get the event loop utilitization so we have a reasonable time frame to check the recent
	// utilization levels (last second) and so we don't have to make these calls to frequently
	setInterval(() => {
		for (let worker of workers) {
			if (!isBun && worker.performance?.eventLoopUtilization) {
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
			} else {
				// Bun doesn't support eventLoopUtilization, use a default idle value
				worker.recentELU = worker.recentELU || { idle: 1, active: 0, utilization: 0 };
			}
		}
		if (monitorListener) monitorListener();
	}, MONITORING_INTERVAL).unref();
}
var REPORTING_INTERVAL = 1000;

if (parentPort && workerData?.addPorts) {
	// Main thread always has threadId 0 (worker_threads convention). Stamp it on
	// parentPort so sendToThread(0, ...) and similar lookups can route back to main.
	// @ts-expect-error - stamping threadId on MessagePort for routing purposes
	parentPort.threadId = 0;
	addPort(parentPort);
	for (let i = 0, l = workerData.addPorts.length; i < l; i++) {
		let port: any = workerData.addPorts[i];
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
		new Promise((resolve) => {
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
export { getThreadInfo };
function removePort(port, deadThreadId) {
	const idx = connectedPorts.indexOf(port);
	if (idx === -1) return;
	connectedPorts.splice(idx, 1);
	// Notify remaining peers to remove this dead sibling port. In Bun, sibling
	// MessagePorts don't emit 'close' when a peer worker exits, so we broadcast
	// a REMOVE_PORT message from here (which fires reliably on Worker 'exit')
	// instead. This is also harmless on Node.js — peers that already cleaned up
	// via 'close' will simply find threadId missing and skip the splice.
	if (deadThreadId != null) {
		for (let remainingPort of connectedPorts) {
			try {
				remainingPort.postMessage({ type: REMOVE_PORT, threadId: deadThreadId });
			} catch {
				// port may already be dead; ignore
			}
		}
	}
}

function addPort(port, keepRef?) {
	connectedPorts.push(port);
	// Capture threadId now — Bun resets port.threadId to -1 by the time 'exit' fires.
	const portThreadId = port.threadId;
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
			} else if (message.type === REMOVE_PORT) {
				const idx = connectedPorts.findIndex((p) => p.threadId === message.threadId);
				if (idx !== -1) connectedPorts.splice(idx, 1);
			} else {
				notifyMessageListeners(message, port);
			}
		})
		.on('close', () => {
			removePort(port, portThreadId);
		})
		.on('exit', () => {
			removePort(port, portThreadId);
		});
	if (keepRef) port.refCount = 100;
	else port.unref();
}
function notifyMessageListeners(message, port) {
	for (let listener of messageListeners) {
		listener(message, port);
	}
	if (message.type) {
		let listeners = listenersByType.get(message.type);
		if (listeners) {
			for (let listener of listeners) {
				try {
					listener(message, port);
				} catch (error) {
					harperLogger.error(error);
				}
			}
		} else if (listeners !== null) {
			// null means it is registered for a later listener
			harperLogger.warn?.(`No listener registered for worker message type ${message.type}, queuing message`);
			let messages = messagesQueuedByType.get(message.type);
			if (!messages) {
				messagesQueuedByType.set(message.type, (messages = []));
			}
			messages.push(message);
		}
	}
}
if (isMainThread) {
	let beforeRestart, queuedRestart;
	let changedFiles = new Set();
	const ignoredPaths = ['node_modules', '.git'];
	const watchDir = async (dir, beforeRestartCallback?) => {
		if (beforeRestartCallback) beforeRestart = beforeRestartCallback;
		chokidar
			.watch(dir, {
				persistent: false,
				ignored: (path) => {
					return ignoredPaths.some((ignoredPath) => path.includes(ignoredPath));
				},
			})
			.on('change', (path) => {
				changedFiles.add(path);
				if (queuedRestart) clearTimeout(queuedRestart);
				queuedRestart = setTimeout(async () => {
					if (beforeRestart) await beforeRestart();
					await restartWorkers();
					console.log('Reloaded Harper components, changed files:', Array.from(changedFiles));
					changedFiles.clear();
				}, 100);
			});
	};
	if (process.env.WATCH_DIR) watchDir(process.env.WATCH_DIR);
} else {
	onMessageByType(hdbTerms.ITC_EVENT_TYPES.SHUTDOWN, async (message) => {
		restartNumber = message.restartNumber;
		parentPort.unref(); // remove this handle
		setTimeout(() => {
			harperLogger.warn('Thread did not voluntarily terminate', threadId);
			// Note that if this occurs, you may want to use this to debug what is currently running:
			// require('why-is-node-running')();
			realExit(0);
		}, threadTerminationTimeout).unref(); // don't block the shutdown
	});
	// In Bun, worker.terminate() triggers a NAPI segfault; the main thread sends FORCE_EXIT
	// instead, and the worker self-exits cleanly to avoid the crash.
	onMessageByType(FORCE_EXIT, () => {
		realExit(0);
	});
}
