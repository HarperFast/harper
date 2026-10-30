import { loadRuntimeModule } from '../utility/packageUtils.js';
import * as jobOwnershipRuntimeModule from './jobs/jobOwnership.ts';
import { isMainThread, workerData } from 'node:worker_threads';
import { getTables } from '../resources/databases.ts';
import {
	loadComponentDirectories,
	loadComponent,
	readyComponentModules,
	startSecretCustodyOnMainThread,
} from '../components/componentLoader.ts';
import { resetResources } from '../resources/Resources.ts';
import * as configUtils from '../config/configUtils.ts';
import { dirname } from 'node:path';
import { loadCertificates } from '../security/keys.ts';
import { installApplications, recoverInterruptedActivations } from '../components/Application.ts';
import { failClosedReleases, liveDeploymentId, RejectedReleaseError } from '../components/releaseCertification.ts';
import { errorForLog } from '../utility/logging/harper_logger.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { settleInterruptedRolloutsOnce } from '../components/deploymentRecorder.ts';
import { sweepFailedPayloadsOnce } from '../components/payloadRetention.ts';

let loadedComponents: any = new Map();

/**
 * Map every component directory to the reason activation recovery could not run. Used only when the scan
 * fails globally, where the safe answer is "none of these are known-good" rather than "all of these are".
 */
async function failEveryComponentClosed(cause?: any) {
	const failures: any = new Map();
	const reason = cause instanceof Error ? cause : new Error(`Activation recovery could not run: ${String(cause)}`);
	try {
		const { readdir } = await import('node:fs/promises');
		const componentsRoot = configUtils.getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
		for (const entry of await readdir(componentsRoot, { withFileTypes: true })) {
			if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink())) {
				failures.set(entry.name, reason);
			}
		}
	} catch (error) {
		console.error(errorForLog(error));
	}
	return failures;
}
/**
 * This is main entry point for loading the main set of global server modules that power Harper.
 * @returns {Promise<void>}
 */
async function loadRootComponents(isWorkerThread: any = false) {
	// Interrupted activations are settled FIRST, before installApplications() — not merely before the
	// component scan. installApplications() installs whatever the root config names, so a candidate left
	// half-swapped by a crash has to be resolved before that runs, or boot reinstalls over it. Failures are
	// per component and returned, not thrown: the loader fails those components closed and loads the rest.
	// Undefined, not an empty Map: a worker skips this branch entirely, and handing the loader an empty map
	// would assert "nothing is unreconciled" on a thread that never checked. The loader treats undefined as
	// "no verdict from boot" instead.
	let interruptedActivationFailures;
	// Before every safe-mode check below, and before any worker inherits this environment: a restart
	// restore that ran out of attempts starts the node in safe mode, so it can be repaired through the
	// operations API without the components that hold the database.
	if (isMainThread && !process.env.HARPER_SAFE_MODE) {
		try {
			if (loadRuntimeModule('dataLayer/restoreIntent').terminalRestoreExists()) {
				process.env.HARPER_SAFE_MODE = 'restore-terminal';
			}
		} catch (error) {
			console.error(errorForLog(error));
		}
	}
	try {
		if (isMainThread && !process.env.HARPER_SAFE_MODE) {
			interruptedActivationFailures = await recoverInterruptedActivations(
				configUtils.getConfigPath(CONFIG_PARAMS.COMPONENTSROOT)
			);
		}
	} catch (error) {
		// The scan itself failed, so WHICH components are unsettled is unknown — loading them all would
		// defeat the fail-closed contract this pass exists for. Every component present is failed closed
		// instead, and a later reload cycle retries once the cause is gone.
		console.error(errorForLog(error));
		interruptedActivationFailures = await failEveryComponentClosed(error);
	}
	// After settlement, which can roll a certified activation forward, and before installApplications(), which
	// reads the config a restore publishes.
	if (isMainThread && !process.env.HARPER_SAFE_MODE) {
		try {
			await loadRuntimeModule('components/canaryRollout').resolveInterruptedCertifications();
		} catch (error) {
			console.error(errorForLog(error));
		}
	}
	try {
		if (isMainThread && !process.env.HARPER_SAFE_MODE) {
			await startSecretCustodyOnMainThread();
			await installApplications();
		}
	} catch (error) {
		console.error(errorForLog(error));
	}
	const failClosed = await componentsFailedClosed();

	let resources = resetResources();
	getTables();
	resources.isWorker = isWorkerThread;

	// Settle jobs whose owning process is gone. Main thread only, and deliberately neither awaited nor
	// fatal: the sweep picks its rows before its first write, so nothing started below can fall into it,
	// and an install carrying a long backlog of interrupted rows must not hold up boot while they settle.
	// An unreconciled job row is misleading, but it is no reason to refuse to start. This function re-runs
	// on every root component reload; the sweep itself holds the once-per-process guard.
	if (isMainThread) {
		// Startup only (it latches): restart restores run here, after `system` is open and before any
		// component, worker or plugin could hold the database they replace.
		let restoreOwnedJobs;
		try {
			restoreOwnedJobs = await loadRuntimeModule('dataLayer/restoreIntent').recoverRestoresAtStartup();
		} catch (error) {
			console.error(errorForLog(error));
		}
		loadRuntimeModule('dataLayer/restoreArchive').sweepImportStagingAtStartup();
		// without the owned set the sweep would fail a pending restart restore's job as interrupted
		if (restoreOwnedJobs) {
			jobOwnershipRuntimeModule
				.reconcileInterruptedJobsOnce(restoreOwnedJobs)
				// A rolling deploy's record is ended by its job, so settle the records once their jobs are.
				.then(() => settleInterruptedRolloutsOnce())
				.catch((error) => console.error(errorForLog(error)));
		}
		// Same shape: once per process, not awaited; expiring old payloads is no reason to hold up boot.
		sweepFailedPayloadsOnce().catch((error) => console.error(errorForLog(error)));
	}

	await loadCertificates();
	// the Harper root component
	await loadComponent(dirname(configUtils.getConfigFilePath()), resources, 'hdb', {
		isRoot: true,
		providedLoadedComponents: loadedComponents,
		autoReload: false,
		failClosed,
	});
	if (!process.env.HARPER_SAFE_MODE) {
		// once the global plugins are loaded, we now load all the CF and run applications (and their components)
		const readyComponentPromises: any = new WeakMap();
		await loadComponentDirectories(
			loadedComponents,
			resources,
			readyComponentPromises,
			interruptedActivationFailures,
			failClosed
		);
		await readyComponentModules(loadedComponents.keys(), readyComponentPromises);
		return;
	}
	await readyComponentModules(loadedComponents.keys());
}

/**
 * Releases no thread may load: those a canary rejected on disk, and those main could not record as rejected and
 * handed to this worker instead. An unreadable answer fails every component closed rather than none.
 */
async function componentsFailedClosed() {
	const componentsRoot = configUtils.getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
	const { processIncarnation } = loadRuntimeModule('server/threads/manageThreads');
	let failClosed;
	try {
		failClosed = await failClosedReleases(componentsRoot, processIncarnation);
	} catch (error) {
		console.error(errorForLog(error));
		failClosed = await failEveryComponentClosed(error);
	}
	// Each holds only while the release it refused is still the live one.
	for (const [component, { deploymentId, reason }] of Object.entries(workerData?.failClosed ?? {}) as [
		string,
		{ deploymentId: string; reason: string },
	][]) {
		if ((await liveDeploymentId(componentsRoot, component).catch(() => undefined)) !== deploymentId) continue;
		failClosed.set(component, new RejectedReleaseError(component, deploymentId, reason));
	}
	return failClosed;
}

export { loadRootComponents };
