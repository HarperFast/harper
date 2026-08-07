import { startWorker, setMonitorListener, setMainIsWorker, threadsHaveStarted } from './manageThreads.js';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import * as harperLogger from '../../utility/logging/harper_logger.ts';
import { recordHostname } from '../../resources/analytics/write.ts';
import { startTransactionLogCooling } from '../transactionLogCooling.ts';
import { isMainThread } from 'worker_threads';
import { join } from 'path';

const workers = [];
const workersReady = [];
// startHTTPThreads() can be called more than once in-process (e.g. a test harness adding more
// worker threads to an already-running server via addThreads()). The crash-path sweep below must
// run only on the very first call — a later call happens after real mirrors are already bound, and
// sweeping the sockets directory then would delete their live files, reintroducing the exact outage
// this guards against.
let sweptSocketsDirectory = false;

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
	// Crash-path defense: a hard crash can skip a worker's exit-time UDS cleanup and leave stale
	// mirror files behind. This runs before any worker below can start (and thus before any mirror
	// can bind), so it can only ever clear files nothing is using yet — never a live mirror. The
	// inode ownership guard in cleanupUdsFiles()/markUdsBindFailed() (see http.ts) is the matching
	// defense for the in-process rolling-restart case, which this sweep does not cover.
	// Lazy dynamic import (not a top-level one), matching server/status/index.ts's own lazy import of
	// http.ts: http.ts's module graph reaches security/auth.ts, whose module-scope table() call needs
	// config already initialized — pulling that graph in at this file's own top level (which
	// bin/run.ts imports before parsing argv / initializing config) breaks startup with "Unable to
	// determine database storage path" before main() ever runs.
	if (isMainThread && !sweptSocketsDirectory) {
		sweptSocketsDirectory = true;
		(await import('../http.ts')).cleanupSocketsDirectory();
	}
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
			const { loadRootComponents } = require('../loadRootComponents.js');
			if (threadCount === 0) {
				setMainIsWorker(true);
				const threadServer = require('./threadServer.js');
				await threadServer.startServers();
				// startServers() schedules listener startup after loading components; await its cached
				// batch so a bind failure reaches bin/run.ts and exits non-zero in single-thread mode too.
				await threadServer.listenOnPorts();
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

/** Resolves on `worker`'s `child_started` message; rejects on a worker `error` or a pre-ready `exit`. */
export function createWorkerReadyPromise(worker, index) {
	return new Promise((resolve, reject) => {
		function cleanup() {
			worker.removeListener('message', onMessage);
			worker.removeListener('error', reject);
			worker.removeListener('exit', onExit);
		}
		function onMessage(message) {
			if (message.type === 'child_started') {
				cleanup();
				resolve(worker);
			}
		}
		function onExit(code) {
			cleanup();
			reject(new Error(`Worker (index ${index}) exited with code ${code} before reporting ready`));
		}

		worker.on('message', onMessage);
		worker.on('error', reject);
		worker.on('exit', onExit);
	});
}

function startHTTPWorker(index, threadCount = 1) {
	startWorker(join(__dirname, './threadServer.js'), {
		name: hdbTerms.THREAD_TYPES.HTTP,
		workerIndex: index,
		threadCount,
		async onStarted(worker) {
			// note that this can be called multiple times, once when started, and again when threads are restarted
			const ready = createWorkerReadyPromise(worker, index);
			workersReady.push(ready);
			try {
				await ready;
			} catch {
				// Already surfaced via workersReady; this call's own promise is fire-and-forget.
				return;
			}
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
