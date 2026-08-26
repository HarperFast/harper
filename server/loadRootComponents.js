const { isMainThread } = require('worker_threads');
const { getTables } = require('../resources/databases.ts');
const { loadComponentDirectories, loadComponent, readyComponentModules } = require('../components/componentLoader.ts');
const { resetResources } = require('../resources/Resources.ts');
const configUtils = require('../config/configUtils.ts');
const { dirname } = require('path');
const { loadCertificates } = require('../security/keys.ts');
const { installApplications, recoverInterruptedActivations } = require('../components/Application.ts');
const { errorForLog } = require('../utility/logging/harper_logger.ts');
const { CONFIG_PARAMS } = require('../utility/hdbTerms.ts');

let loadedComponents = new Map();

/**
 * Map every component directory to the reason activation recovery could not run. Used only when the scan
 * fails globally, where the safe answer is "none of these are known-good" rather than "all of these are".
 */
async function failEveryComponentClosed(cause) {
	const failures = new Map();
	const reason = cause instanceof Error ? cause : new Error(`Activation recovery could not run: ${String(cause)}`);
	try {
		const { readdir } = require('node:fs/promises');
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
async function loadRootComponents(isWorkerThread = false) {
	// Interrupted activations are settled FIRST, before installApplications() — not merely before the
	// component scan. installApplications() installs whatever the root config names, so a candidate left
	// half-swapped by a crash has to be resolved before that runs, or boot reinstalls over it. Failures are
	// per component and returned, not thrown: the loader fails those components closed and loads the rest.
	let interruptedActivationFailures = new Map();
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
	try {
		if (isMainThread && !process.env.HARPER_SAFE_MODE) await installApplications();
	} catch (error) {
		console.error(errorForLog(error));
	}

	let resources = resetResources();
	getTables();
	resources.isWorker = isWorkerThread;

	await loadCertificates();
	// the Harper root component
	await loadComponent(dirname(configUtils.getConfigFilePath()), resources, 'hdb', {
		isRoot: true,
		providedLoadedComponents: loadedComponents,
		autoReload: false,
	});
	if (!process.env.HARPER_SAFE_MODE) {
		// once the global plugins are loaded, we now load all the CF and run applications (and their components)
		const readyComponentPromises = new WeakMap();
		await loadComponentDirectories(loadedComponents, resources, readyComponentPromises, interruptedActivationFailures);
		await readyComponentModules(loadedComponents.keys(), readyComponentPromises);
		return;
	}
	await readyComponentModules(loadedComponents.keys());
}

module.exports.loadRootComponents = loadRootComponents;
