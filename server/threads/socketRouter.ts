import { startWorker, setMonitorListener, setMainIsWorker, threadsHaveStarted } from './manageThreads.js';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import * as harperLogger from '../../utility/logging/harper_logger.ts';
import { recordHostname } from '../../resources/analytics/write.ts';
import { startTransactionLogCooling } from '../transactionLogCooling.ts';
import { isMainThread } from 'worker_threads';
import { join } from 'path';

const workers = [];
const HTTP_WORKER_STARTUP_DIAGNOSTIC_MS = 60000;
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
	const workerSlots = [];
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
			workerSlots.push(startHTTPWorker(0, 1));
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
			workerSlots.push(startHTTPWorker(i, threadCount));
		}
		await Promise.all(workerSlots.map((slot) => slot.ready));
	} finally {
		for (const slot of workerSlots) slot.finishStartup();
		threadsHaveStarted(undefined as any);
	}
}

function startHTTPWorker(index, threadCount = 1) {
	let resolveReady, rejectReady;
	let waitingForInitialReady = true;
	let finishCurrentStartup = () => {};
	let startupAttempts = 0;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const finishStartup = () => {
		waitingForInitialReady = false;
		finishCurrentStartup();
	};
	const failStartup = (error) => {
		if (!waitingForInitialReady) return;
		waitingForInitialReady = false;
		finishCurrentStartup();
		rejectReady(error);
	};
	const workerOptions = {
		name: hdbTerms.THREAD_TYPES.HTTP,
		workerIndex: index,
		threadCount,
		onStarted(worker) {
			// onStarted runs for each managed restart; readiness belongs to this slot, not a Worker instance.
			const attempt = ++startupAttempts;
			let startupPhase = 'starting';
			let workerReady = false;
			let startupDiagnostic;
			const removeWorker = () => {
				const workerPosition = workers.indexOf(worker);
				if (workerPosition > -1) workers.splice(workerPosition, 1);
			};
			const cleanupStartup = () => {
				clearTimeout(startupDiagnostic);
				worker.off('message', onMessage);
			};
			const describeStartup = (event) =>
				`HTTP worker slot ${index} ${event} before ready (thread ${worker.threadId}, attempt ${attempt}, phase ${startupPhase})`;
			const onMessage = (message) => {
				if (message.type === hdbTerms.ITC_EVENT_TYPES.CHILD_STARTUP_PHASE) {
					startupPhase = message.phase;
					return;
				}
				if (message.type !== hdbTerms.ITC_EVENT_TYPES.CHILD_STARTED) return;
				workerReady = true;
				cleanupStartup();
				if (waitingForInitialReady) {
					waitingForInitialReady = false;
					resolveReady();
				}
				if (!workers.includes(worker)) workers.push(worker);
				worker.on('shutdown', removeWorker);
			};
			const onExit = () => {
				cleanupStartup();
				if (workerReady) removeWorker();
				else {
					const message = describeStartup('exited');
					harperLogger.error(message);
				}
			};
			worker.on('message', onMessage);
			worker.on('exit', onExit);
			if (waitingForInitialReady) {
				startupDiagnostic = setTimeout(() => {
					if (workerReady || !waitingForInitialReady) return;
					const message = describeStartup(`has not become ready after ${HTTP_WORKER_STARTUP_DIAGNOSTIC_MS}ms`);
					harperLogger.error(message);
				}, HTTP_WORKER_STARTUP_DIAGNOSTIC_MS).unref();
				finishCurrentStartup = cleanupStartup;
			}
		},
		onRestartExhausted(worker) {
			failStartup(new Error(`HTTP worker slot ${index} exhausted restarts before ready (thread ${worker.threadId})`));
		},
	};
	startWorker(join(__dirname, './threadServer.js'), workerOptions);
	return { ready, finishStartup };
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
