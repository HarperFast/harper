'use strict';

// The guard first, exactly as `jobProcess.ts` does it: from here on this thread runs a CANDIDATE's code,
// which must not be able to terminate the thread out from under the verdict protocol.
import { realExit } from '../server/threads/workerProcessGuard.ts';

import { basename } from 'node:path';
import { workerData } from 'node:worker_threads';

import { HDB_ROOT_DIR_NAME } from '../utility/hdbTerms.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import { Resources } from '../resources/Resources.ts';
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
// Captured and then REMOVED from `workerData`, before any candidate code runs. `workerData` is reachable
// from the candidate — `require('node:worker_threads').workerData` — so leaving the port there would let a
// candidate post its own passing verdict and certify itself. Taking it out of the bag is the difference
// between a capability this module holds and one the whole thread holds.
const { candidateDirPath, appName } = workerData ?? {};
const verdictPort = workerData?.verdictPort;
if (workerData) delete workerData.verdictPort;

async function certify(): Promise<void> {
	const componentName = appName || basename(candidateDirPath);
	const loadOptions = rootApplicationLoadOptions(componentName, { forCertification: true });
	if (!loadOptions.ok) {
		throw new Error(`Cannot certify ${componentName}: its root-config mount could not be resolved`);
	}
	// The candidate's own load-time error, not just whether the promise rejected: the loader reports some
	// failures through the error reporter while resolving successfully.
	let reportedError: Error | undefined;
	setErrorReporter((error: Error) => (reportedError ??= error));
	const resources = new Resources();
	// A certification load has to run the code a WORKER runs — the `start`/`handleApplication` extension
	// path — or it proves only that the module parsed.
	resources.isWorker = true;
	// Collected so teardown happens BEFORE the verdict, not after. The in-process check this replaces
	// established that a Scope which fails to close is a REJECTED validation, not a warning: `close()` stops
	// at the throwing listener, so the scope stays partially live. Posting a pass and then failing teardown
	// would certify a candidate whose own cleanup is broken — and the thread exits either way, so nothing
	// downstream would ever learn.
	const scopes = new Set<Scope>();
	try {
		await loadComponent(candidateDirPath, resources, HDB_ROOT_DIR_NAME, {
			...loadOptions.options,
			collectScopes: scopes,
		});
		if (reportedError) throw reportedError;
	} finally {
		const closes = await Promise.allSettled(Array.from(scopes, (scope) => scope.close()));
		const failed = closes.filter((result) => result.status === 'rejected');
		if (failed.length && !reportedError) {
			throw new AggregateError(
				failed.map((result) => (result as PromiseRejectedResult).reason),
				`${componentName} loaded but ${failed.length} scope(s) failed to tear down`
			);
		}
	}
}

function report(verdict: { ok: true } | { ok: false; message: string; stack?: string }): void {
	// Its own channel rather than `parentPort`, which carries Harper's ITC traffic. A closed or absent
	// channel is the parent's problem to detect (it treats a missing verdict as failure), so this must not
	// throw its way out of the exit path.
	try {
		verdictPort?.postMessage(verdict);
	} catch (error) {
		harperLogger.warn('Deploy certification could not post its verdict:', error);
	}
}

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
	}
})();
