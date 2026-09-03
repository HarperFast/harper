'use strict';

// The guard first, exactly as `jobProcess.ts` does it: from here on this thread runs a CANDIDATE's code,
// which must not be able to terminate the thread out from under the verdict protocol.
import { realExit } from '../server/threads/workerProcessGuard.ts';

import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import { HDB_ROOT_DIR_NAME } from '../utility/hdbTerms.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import {
	PROGRESS_CANDIDATE_LOADED,
	PROGRESS_CERTIFY_ENTERED,
	PROGRESS_EXIT_OBSERVED,
	PROGRESS_MODULE_SCOPE,
	PROGRESS_ROOT_PLUGINS_LOADED,
	PROGRESS_TEARDOWN_DONE,
	SLOT_PROGRESS,
	SLOT_VERDICT,
	VERDICT_CERTIFIED,
	VERDICT_REJECTED,
} from './certifyCandidate.ts';
import { loadComponent, rootApplicationLoadOptions, setErrorReporter } from './componentLoader.ts';
import type { Scope } from './Scope.ts';

/**
 * Entry point for an ephemeral deploy-certification worker.
 *
 * Loads ONE candidate tree under its real application identity and root-config mount, and reports whether
 * it loaded. Nothing else: this thread never joins the serving topology, serves a request, or outlives its
 * verdict. It exists so that `deploy_component` can certify a candidate on any thread — the in-process
 * check it replaces was gated on `!isMainThread`, and the operations API deploys on main, so an operator
 * deploy was certified by nothing at all.
 *
 * The verdict is posted exactly once and the thread then exits. Every other outcome — a throw, an exit
 * without a verdict, a malformed message — is failure at the parent, which is what makes "inability to
 * obtain a verdict is failure" true rather than aspirational.
 */
// Captured and REMOVED from `workerData` before any candidate code runs: `workerData` is reachable from
// the candidate via `require('node:worker_threads')`, so a port left there would let a candidate post its
// own passing verdict and certify itself.
const { candidateDirPath, appName } = workerData ?? {};
const verdictPort = workerData?.verdictPort;
const verdictFlag: Int32Array | undefined = workerData?.verdictFlag;
if (workerData) {
	delete workerData.verdictPort;
	delete workerData.verdictFlag;
}

/** Record the furthest phase reached, in the one channel that survives this thread's exit on every platform. */
function markProgress(phase: number): void {
	if (verdictFlag) Atomics.store(verdictFlag, SLOT_PROGRESS, phase);
}

markProgress(PROGRESS_MODULE_SCOPE);

/** Whether a candidate declares anything a load should act on, so "loaded nothing" can be judged. */
async function declaresLoadableContent(dirPath: string): Promise<boolean> {
	for (const name of ['config.yaml', 'config.yml', 'package.json']) {
		try {
			await stat(join(dirPath, name));
			return true;
		} catch {
			// Absent is the only answer that matters here; an unreadable candidate fails the load itself.
		}
	}
	return false;
}

/** The bootstrap's own bound, well inside the parent's certification deadline so this error is the one seen. */
const BOOTSTRAP_DEADLINE_MS = 60_000;

/** Reject with a phase-naming error if `work` does not settle in time, so a hang is diagnosable. */
async function withPhaseDeadline<T>(work: Promise<T>, ms: number, phase: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Certification timed out after ${ms}ms while ${phase}`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function certify(): Promise<void> {
	markProgress(PROGRESS_CERTIFY_ENTERED);
	const componentName = appName || basename(candidateDirPath);
	const loadOptions = rootApplicationLoadOptions(componentName, { forCertification: true });
	if (!loadOptions.ok) {
		throw new Error(`Cannot certify ${componentName}: its root-config mount could not be resolved`);
	}
	// The global plugins first: they create the surfaces applications extend, so a component assigning
	// `server.mqtt.authorizeClient` needs the mqtt plugin loaded or the assignment throws on `undefined` and
	// certification rejects something a serving worker loads fine. Loading stops before the other
	// applications, which is why this is a separate entry point from `loadRootComponents`.
	const { loadRootPlugins } = await import('../server/loadRootComponents.js');
	// Bounded, and it says WHICH phase did not finish. This bootstrap loads Harper's global plugins, parts
	// of which expect to be a member of the worker topology a validator deliberately is not — so it can
	// wait on something that will never arrive here. Without a bound that is indistinguishable from a
	// candidate that hangs, and on Windows it presented as a silent exit.
	const resources = await withPhaseDeadline(
		loadRootPlugins(true),
		BOOTSTRAP_DEADLINE_MS,
		`loading Harper's global plugins`
	);
	markProgress(PROGRESS_ROOT_PLUGINS_LOADED);

	// Installed AFTER the bootstrap so it only ever sees the candidate. Earlier, it captures the first error
	// from anything the root config names — including the candidate's own live path, which `deploy_component`
	// writes before building and which does not exist yet on a first deploy.
	//
	// A reporter is needed at all because the loader reports some failures through it while still resolving.
	let reportedError: Error | undefined;
	setErrorReporter((error: Error) => (reportedError ??= error));
	// Collected so teardown happens BEFORE the verdict. A scope that fails to close is a rejected
	// validation, not a warning: `close()` stops at the throwing listener, leaving the scope partially live,
	// and the thread exits either way so nothing downstream would learn of a failure reported after a pass.
	const scopes = new Set<Scope>();
	const modules = new Set<any>();
	let loaded = false;
	try {
		await loadComponent(candidateDirPath, resources, HDB_ROOT_DIR_NAME, {
			...loadOptions.options,
			collectScopes: scopes,
			collectLoadedModules: modules,
		});
		if (reportedError) throw reportedError;
		// A load that did nothing is not a pass: a run that neither opened a scope nor loaded a module has
		// not exercised the candidate, which is how a platform-specific no-op would read as a clean verdict.
		// A static-only component stays clear of this because its load still opens a scope, which
		// `deployCertification.test.js` pins.
		if (!scopes.size && !modules.size && (await declaresLoadableContent(candidateDirPath))) {
			throw new Error(
				`Certification of ${componentName} loaded nothing: it declares component configuration, so a run ` +
					`that opened no scope and loaded no module has not exercised it`
			);
		}
		loaded = true;
		markProgress(PROGRESS_CANDIDATE_LOADED);
	} finally {
		const closes = await Promise.allSettled(Array.from(scopes, (scope) => scope.close()));
		const failed = closes.filter((result) => result.status === 'rejected');
		// Only when the load itself succeeded. A throw from `loadComponent` — a syntax error, an unreadable
		// file — reaches this block too, and a teardown failure there would replace the candidate's real
		// error with a note about its scopes: the operator would get the symptom instead of the cause.
		if (failed.length && loaded) {
			throw new AggregateError(
				failed.map((result) => (result as PromiseRejectedResult).reason),
				`${componentName} loaded but ${failed.length} scope(s) failed to tear down`
			);
		}
		if (loaded) markProgress(PROGRESS_TEARDOWN_DONE);
	}
}

// The receiver for the parent's Bun force-exit, registered here rather than inherited as an import side
// effect of `manageThreads`: `terminate()` segfaults under Bun, so this message is the only way the parent
// can end the thread, and that must not depend on which modules happened to load.
parentPort?.on('message', (message: any) => {
	if (message?.type === 'force-exit') realExit(0);
});

function report(verdict: { ok: true } | { ok: false; message: string; stack?: string }): void {
	// The flag first, and synchronously: this thread exits immediately after, and a posted message loses
	// that race on Windows. Shared memory needs no event-loop turn.
	if (verdictFlag) Atomics.store(verdictFlag, SLOT_VERDICT, verdict.ok ? VERDICT_CERTIFIED : VERDICT_REJECTED);
	// A closed or absent channel is the parent's problem to detect — it treats a missing verdict as failure —
	// so this must not throw its way out of the exit path.
	try {
		verdictPort?.postMessage(verdict);
	} catch (error) {
		harperLogger.warn('Deploy certification could not post its verdict:', error);
	}
}

// Provenance for an exit that reported nothing, written where it CANNOT be lost.
//
// A first attempt logged a stack from this handler and produced nothing on Windows: a worker's
// `console.error` is piped to the parent asynchronously, so anything written on the way out loses the same
// race the verdict message loses. Shared memory needs no event-loop turn, so the phase markers below travel
// through it instead, and this handler marks that the thread ended ITSELF — a thread torn down from outside
// (`terminate()`, a native abort, the process going away) never runs it, and that absence is the evidence.
process.on('exit', () => {
	if (!verdictFlag) return;
	const progress = Atomics.load(verdictFlag, SLOT_PROGRESS);
	if (progress < PROGRESS_EXIT_OBSERVED) Atomics.store(verdictFlag, SLOT_PROGRESS, progress + PROGRESS_EXIT_OBSERVED);
});

// A ref'd handle for the whole certification: a worker's event loop draining ends the thread even with a
// promise still pending, which would reach the parent as "exited without a verdict" rather than as a hang,
// with no timeout left alive to fire.
const keepAlive = setInterval(() => {}, 1000);

void (async () => {
	try {
		await certify();
		report({ ok: true });
		realExit(0);
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		// The message travels rather than the Error: an Error does not survive `postMessage` with its
		// prototype, and the parent only needs what it will put in the operation's own error.
		report({ ok: false, message: failure.message, stack: failure.stack });
		realExit(1);
	} finally {
		clearInterval(keepAlive);
	}
})();
