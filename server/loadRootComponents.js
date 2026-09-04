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
	// Undefined, not an empty Map: a worker skips this branch entirely, and handing the loader an empty map
	// would assert "nothing is unreconciled" on a thread that never checked. The loader treats undefined as
	// "no verdict from boot" instead.
	let interruptedActivationFailures;
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

	const resources = await loadRootPlugins(isWorkerThread);
	if (!process.env.HARPER_SAFE_MODE) {
		// once the global plugins are loaded, we now load all the CF and run applications (and their components)
		const readyComponentPromises = new WeakMap();
		await loadComponentDirectories(loadedComponents, resources, readyComponentPromises, interruptedActivationFailures);
		await readyComponentModules(loadedComponents.keys(), readyComponentPromises);
		return;
	}
	await readyComponentModules(loadedComponents.keys());
}

/**
 * Load the Harper root component — the global plugins — and nothing that depends on them.
 *
 * This is the boundary the deploy certification validator needs. Plugins are what establish the surfaces
 * applications extend (`server.mqtt.authorizeClient` and friends), so a certification load without them
 * fails a component that works perfectly on a serving worker: the plugin surface is simply absent. But the
 * validator must NOT go on to load the other applications, which is exactly where this function stops.
 *
 * Extracted rather than duplicated so the two callers cannot drift on what "the plugins are loaded" means.
 * Listeners are not bound here: plugins register handlers on the scope's server object, and the port
 * binding belongs to `threadServer`'s startup, which a validator suppresses with `workerData.noServerStart`.
 */
async function loadRootPlugins(isWorkerThread = false) {
	const resources = resetResources();
	getTables();
	resources.isWorker = isWorkerThread;

	await loadCertificates();
	await loadComponent(dirname(configUtils.getConfigFilePath()), resources, 'hdb', {
		isRoot: true,
		providedLoadedComponents: loadedComponents,
		autoReload: false,
	});
	return resources;
}

module.exports.loadRootComponents = loadRootComponents;
module.exports.loadRootPlugins = loadRootPlugins;
