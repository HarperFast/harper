import { startWorker, setMonitorListener, setMainIsWorker, threadsHaveStarted } from './manageThreads.ts';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import * as harperLogger from '../../utility/logging/harper_logger.ts';
import { recordHostname } from '../../resources/analytics/write.ts';
import { startTransactionLogCooling } from '../transactionLogCooling.ts';
import { isMainThread } from 'worker_threads';
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
		console.error('uncaughtException', harperLogger.errorForLog(error));
	});
}

export async function startHTTPThreads(threadCount = 2, dynamicThreads?: boolean) {
	recordHostname().catch((err) => harperLogger.error?.('Error recording hostname for analytics:', err));
	// Drive transaction-log cooling from the main thread (the registry is a
	// process-global singleton; see startTransactionLogCooling). Runs for all
	// thread modes below, including the single-threaded (threadCount === 0) path.
	startTransactionLogCooling();
	try {
		if (dynamicThreads) {
			// No caller currently passes dynamicThreads. If one ever does, note that the main thread
			// does not bind ports in this mode, so on platforms without SO_REUSEPORT (macOS/Windows)
			// worker 0's exclusive HTTP bind would silently swallow an external EADDRINUSE — the
			// external-conflict detection in listenOnPorts() assumes the main thread binds first.
			startHTTPWorker(0, 1);
		} else {
			const { loadRootComponents } = await import('../loadRootComponents.ts');
			if (threadCount === 0) {
				setMainIsWorker(true);
				await (await import('./threadServer.ts')).startServers();
				return Promise.resolve([]);
			}
			await loadRootComponents();
			const { listenOnPorts } = await import('./threadServer.ts');
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
	// Worker entry path is resolved by startWorker() against PACKAGE_ROOT,
	// which differs between source (`core/server/threads/...`) and dist
	// (`core/dist/server/threads/...`). startWorker handles the rewrite.
	startWorker('server/threads/threadServer', {
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
