import { startWorker, setMonitorListener, setMainIsWorker, threadsHaveStarted } from './manageThreads.js';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import * as harperLogger from '../../utility/logging/harper_logger.ts';
import { recordHostname } from '../../resources/analytics/write.ts';
import { isMainThread } from 'worker_threads';
import { join } from 'path';

const workers = [];
const workersReady = [];

if (isMainThread) {
	process.on('uncaughtException', (error) => {
		// TODO: Maybe we should try to log the first of each type of error
		if ((error as any).code === 'ECONNRESET') return; // that's what network connections do
		if ((error as any).code === 'EIO') {
			// that means the terminal is closed
			harperLogger.disableStdio();
			return;
		}
		console.error('uncaughtException', error);
	});
}

export async function startHTTPThreads(threadCount = 2, dynamicThreads?: boolean) {
	recordHostname().catch((err) => harperLogger.error?.('Error recording hostname for analytics:', err));
	try {
		if (dynamicThreads) {
			startHTTPWorker(0, 1);
		} else {
			const { loadRootComponents } = require('../loadRootComponents.js');
			if (threadCount === 0) {
				setMainIsWorker(true);
				await require('./threadServer.js').startServers();
				return Promise.resolve([]);
			}
			await loadRootComponents();
			const { listenOnPorts } = require('./threadServer.js');
			await listenOnPorts();
			// Windows does not support SO_REUSEPORT, so only a single HTTP worker is supported.
			if (process.platform === 'win32') threadCount = 1;
		}
		for (let i = 0; i < threadCount; i++) {
			startHTTPWorker(i, threadCount);
		}
		await Promise.all(workersReady);
	} finally {
		threadsHaveStarted(undefined as any);
	}
}

function startHTTPWorker(index, threadCount = 1) {
	startWorker(join(__dirname, './threadServer.js'), {
		name: hdbTerms.THREAD_TYPES.HTTP,
		workerIndex: index,
		threadCount,
		async onStarted(worker) {
			// note that this can be called multiple times, once when started, and again when threads are restarted
			const ready = new Promise((resolve, reject) => {
				function onMessage(message) {
					if (message.type === 'child_started') {
						worker.removeListener('message', onMessage);
						resolve(worker);
					}
				}

				worker.on('message', onMessage);
				worker.on('error', reject);
			});
			workersReady.push(ready);
			await ready;
			workers.push(worker);
			worker.on('exit', removeWorker);
			worker.on('shutdown', removeWorker);
			function removeWorker() {
				const index = workers.indexOf(worker);
				if (index > -1) workers.splice(index, 1);
			}
		},
	});
}

// basically, the amount of additional idleness to expect based on previous idleness (some work will continue, some
// won't)
const EXPECTED_IDLE_DECAY = 1000;

/**
 * Updates the idleness statistics for each worker
 */
export function updateWorkerIdleness() {
	for (const worker of workers) {
		worker.expectedIdle = worker.recentELU.idle + EXPECTED_IDLE_DECAY;
		worker.requests = 1;
	}
	workers.sort((a, b) => (a.expectedIdle > b.expectedIdle ? -1 : 1));
}

setMonitorListener(updateWorkerIdleness);
