import {
	startWorker,
	setMonitorListener,
	setMainIsWorker,
	threadsHaveStarted,
	setIsolatedWorkerReconciler,
	setRunningIsolatedApplicationsGetter,
	workersForApplication,
	stopWorker,
} from './manageThreads.js';
import {
	presentIsolatedApplicationNames,
	isolatedApplicationRefusal,
	isolatedApplicationCapacityRefusal,
} from './isolatedApplications.ts';
import { lifecycle as componentLifecycle } from '../../components/status/index.ts';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import * as harperLogger from '../../utility/logging/harper_logger.ts';
import { recordHostname } from '../../resources/analytics/write.ts';
import { startTransactionLogCooling } from '../transactionLogCooling.ts';
import { startLongLivedTransactionReporting } from '../../resources/longLivedTransactions.ts';
import { isMainThread } from 'node:worker_threads';
import { join } from 'node:path';

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
		// Same `isHandled` contract as threadServer.js: an error another handler has already
		// classified (a lost native file watch, for instance) must not be logged again here.
		if ((error as any).isHandled) return;
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
	startLongLivedTransactionReporting();
	try {
		if (dynamicThreads) {
			// No caller currently passes dynamicThreads. If one ever does, note that the main thread
			// does not bind ports in this mode, so on platforms without SO_REUSEPORT (macOS/Windows)
			// worker 0's exclusive HTTP bind would silently swallow an external EADDRINUSE — the
			// external-conflict detection in listenOnPorts() assumes the main thread binds first.
			const slot = startHTTPWorker(0, 1);
			workerSlots.push(slot);
			poolSlots.push(slot);
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
		poolSize = threadCount;
		nextIsolatedIndex = Math.max(nextIsolatedIndex, threadCount);
		const isolated = admittedIsolatedApplications([...isolatedSlots.keys()]);
		const heapShareCount = threadCount + isolated.length;
		for (let i = 0; i < threadCount; i++) {
			const slot = startHTTPWorker(i, threadCount, undefined, heapShareCount);
			workerSlots.push(slot);
			poolSlots.push(slot);
		}
		// One dedicated worker per isolated application, numbered past the pool so no pool-only duty
		// (worker 0's startup log, the last worker's cleanup) ever lands on it.
		for (const application of isolated) {
			if (isolatedSlots.has(application)) continue;
			const slot = startHTTPWorker(nextIsolatedIndex++, threadCount, application, heapShareCount);
			isolatedSlots.set(application, slot);
			workerSlots.push(slot);
			void watchDedicatedStart(application, slot);
		}
		await Promise.all(workerSlots.filter((slot) => !slot.application).map((slot) => slot.ready));
	} finally {
		for (const slot of workerSlots) if (!slot.application) slot.finishStartup();
		threadsHaveStarted(undefined as any);
	}
}

let poolSize = 0;
const refusedIsolated = new Set<string>(); // reported once, not on every reconcile
const ISOLATED_WORKER_READY_TIMEOUT_MS = 60_000; // the pool replacement path's backstop
let nextIsolatedIndex = 0;
type IsolatedSlot = {
	ready: Promise<void>;
	finishStartup: () => void;
	shutdown: () => Promise<void>;
	setHeapShareCount: (count: number) => void;
	application?: string;
};
const isolatedSlots = new Map<string, IsolatedSlot>();
const poolSlots: IsolatedSlot[] = [];

/**
 * The isolated applications that get a dedicated worker. Ones already running keep their place; new
 * ones are admitted up to `threads.maxIsolated`, and only while a dedicated worker would be reachable
 * at all. Everything refused is refused loudly and loaded nowhere -- never downgraded to the pool.
 */
function admittedIsolatedApplications(running: string[]): string[] {
	const names = presentIsolatedApplicationNames();
	const admitted = [];
	for (const name of running) {
		if (!names.includes(name)) continue;
		const refusal = isolatedApplicationRefusal(name);
		if (refusal) {
			reportIsolatedRefusal(name, refusal);
			continue;
		}
		admitted.push(name);
	}
	for (const name of names) {
		if (admitted.includes(name)) continue;
		const refusal = isolatedApplicationRefusal(name) ?? isolatedApplicationCapacityRefusal(name, admitted);
		if (refusal) {
			reportIsolatedRefusal(name, refusal);
			continue;
		}
		refusedIsolated.delete(name);
		admitted.push(name);
	}
	return admitted;
}

function reportIsolatedRefusal(name: string, refusal: string) {
	if (refusedIsolated.has(name)) return;
	refusedIsolated.add(name);
	const error = new Error(
		`Application '${name}' is isolated but gets no dedicated worker: ${refusal}; it is not loaded anywhere`
	);
	harperLogger.error(error.message);
	componentLifecycle.failed(name, error, `Component '${name}' failed to load`);
}

/**
 * Wait for a dedicated worker to become ready, with the pool replacement path's backstop. A worker that
 * fails, or stays alive without ever reporting ready, is recorded as a failed component, stopped, and
 * only then has its slot freed, so the next reconcile retries against a worker that has exited.
 * Resolves whether it became ready.
 */
function watchDedicatedStart(application: string, slot: IsolatedSlot): Promise<boolean> {
	return Promise.race([
		slot.ready,
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error(`Dedicated worker for '${application}' did not become ready in time`)),
				ISOLATED_WORKER_READY_TIMEOUT_MS
			).unref()
		),
	])
		.then(() => true)
		.catch(async (error) => {
			harperLogger.error(`Dedicated worker for isolated application '${application}' failed to start`, error);
			componentLifecycle.failed(application, error, `Component '${application}' failed to load`);
			// The slot IS the lease: holding it until the failed worker has actually exited is what stops a
			// reconcile from starting a replacement over its still-bound UDS mirror and still-open stores,
			// and what makes a concurrent drop's `await slot.shutdown()` cover this worker too.
			await slot.shutdown();
			if (isolatedSlots.get(application) !== slot) return false; // a drop already withdrew this lease
			isolatedSlots.delete(application);
			const { cleanupApplicationSockets } = await import('../http.ts');
			// A reconcile may have installed a replacement while that import resolved. Never unlink its mirror.
			if (!isolatedSlots.has(application)) cleanupApplicationSockets(application);
			return false;
		})
		.finally(() => slot.finishStartup());
}

/**
 * Bring the dedicated workers in line with the root config: start one for each isolated application
 * that has none, stop the one of an application that is no longer isolated or no longer configured.
 * Runs on the main thread after every root-component reload (deploy, drop, restart).
 */
let reconciling: Promise<string[]> = Promise.resolve([]);
export function reconcileIsolatedWorkers(): Promise<string[]> {
	// serialized: two reloads in flight must not compute `wanted` against each other's half-done work
	reconciling = reconciling.then(reconcileIsolatedWorkersNow, reconcileIsolatedWorkersNow);
	return reconciling;
}

async function reconcileIsolatedWorkersNow(): Promise<string[]> {
	if (!isMainThread || poolSize === 0) return [];
	const wanted = new Set(admittedIsolatedApplications([...isolatedSlots.keys()]));
	const stopping = [];
	for (const [application, slot] of isolatedSlots) {
		if (wanted.has(application)) continue;
		isolatedSlots.delete(application);
		// awaited: a caller that goes on to remove the application's storage must see its worker gone
		stopping.push(slot.shutdown().then(() => application));
	}
	const stoppedApplications = await Promise.all(stopping);
	if (stoppedApplications.length > 0) {
		const { cleanupApplicationSockets } = await import('../http.ts');
		for (const application of stoppedApplications) cleanupApplicationSockets(application);
	}
	const started: string[] = [];
	const heapShareCount = poolSize + wanted.size;
	for (const slot of poolSlots) slot.setHeapShareCount(heapShareCount);
	for (const slot of isolatedSlots.values()) slot.setHeapShareCount(heapShareCount);
	for (const application of wanted) {
		if (isolatedSlots.has(application)) continue;
		const slot = startHTTPWorker(nextIsolatedIndex++, poolSize, application, heapShareCount);
		isolatedSlots.set(application, slot);
		started.push(application);
		void watchDedicatedStart(application, slot);
	}
	return started;
}
if (isMainThread) {
	setIsolatedWorkerReconciler(reconcileIsolatedWorkers);
	setRunningIsolatedApplicationsGetter(() => [...isolatedSlots.keys()]);
}

function startHTTPWorker(index, threadCount = 1, application?: string, heapShareCount?: number) {
	const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
	let waitingForInitialReady = true;
	let finishCurrentStartup = () => {};
	let startupAttempts = 0;
	// A Worker's threadId reads back as -1 once it has exited, which is exactly when the diagnostics
	// below run, so each attempt records its id while the worker is still alive.
	let lastThreadId = -1;
	let isolatedSlot: IsolatedSlot | undefined;
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
		application,
		heapShareCount,
		shouldAutoRestart: application
			? () => isolatedSlot !== undefined && isolatedSlots.get(application) === isolatedSlot
			: undefined,
		onStarted(worker) {
			const attempt = ++startupAttempts;
			const threadId = (lastThreadId = worker.threadId);
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
				`HTTP worker slot ${index}${application ? ` (isolated application '${application}')` : ''} ${event} before ready (thread ${threadId}, attempt ${attempt}, phase ${startupPhase})`;
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
				// A rolling restart marks both the outgoing worker and its still-booting replacement
				// wasShutdown, so a shutdown landing mid-boot is routine, not a startup failure.
				else if (!worker.wasShutdown) harperLogger.error(describeStartup('exited'));
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
		onRestartExhausted() {
			const error = new Error(`HTTP worker slot ${index} exhausted restarts (thread ${lastThreadId})`);
			if (waitingForInitialReady) failStartup(error);
			else if (application && isolatedSlot && isolatedSlots.get(application) === isolatedSlot) {
				isolatedSlots.delete(application);
				componentLifecycle.failed(application, error, `Component '${application}' worker failed`);
				void import('../http.ts').then(
					({ cleanupApplicationSockets }) => {
						// A config reconciliation may already have installed a replacement after the
						// exhausted slot released its lease. Never unlink that replacement's mirror.
						if (isolatedSlots.has(application)) return;
						cleanupApplicationSockets(application);
					},
					(cleanupError) => {
						harperLogger.error(
							`Could not clean sockets for failed isolated application '${application}'`,
							cleanupError
						);
					}
				);
			}
		},
	};
	startWorker(join(__dirname, './threadServer.js'), workerOptions);
	// Stop of a dedicated worker whose application is gone: every worker carrying the application,
	// a crashed one's replacement still booting included, so none is left running the removed app.
	let shutdownPromise: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		if (!application) return Promise.resolve();
		if (shutdownPromise) return shutdownPromise;
		shutdownPromise = Promise.all(workersForApplication(application).map((worker) => stopWorker(worker))).then(
			() => undefined
		);
		failStartup(new Error(`Dedicated worker for '${application}' was stopped before it became ready`));
		return shutdownPromise;
	};
	const setHeapShareCount = (count: number) => {
		workerOptions.heapShareCount = count;
	};
	isolatedSlot = { ready, finishStartup, shutdown, setHeapShareCount, application };
	return isolatedSlot;
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
