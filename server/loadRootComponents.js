const { isMainThread } = require('worker_threads');
const { getTables } = require('../resources/databases.ts');
const { loadComponentDirectories, loadComponent, readyComponentModules } = require('../components/componentLoader.ts');
const { resetResources } = require('../resources/Resources.ts');
const configUtils = require('../config/configUtils.ts');
const { dirname } = require('path');
const { loadCertificates } = require('../security/keys.ts');
const { installApplications, recoverInterruptedActivations } = require('../components/Application.ts');
const { publishComponentConfigEntry } = require('../components/componentLoader.ts');
const { errorForLog } = require('../utility/logging/harper_logger.ts');
const { CONFIG_PARAMS } = require('../utility/hdbTerms.ts');

let loadedComponents = new Map();
/**
 * This is main entry point for loading the main set of global server modules that power Harper.
 * @returns {Promise<void>}
 */
async function loadRootComponents(isWorkerThread = false) {
	// Interrupted activations are settled FIRST, before installApplications() — not merely before the
	// component scan. installApplications() installs from the root config, so a crash that left a journal
	// and an unpublished config entry would otherwise have it reinstall the PREVIOUS release over a
	// candidate that is already live, and the later recovery pass would then publish the new config against
	// the reinstalled old tree. Failures are per component and returned, not thrown: the loader fails those
	// components closed and still loads the rest.
	let interruptedActivationFailures = new Map();
	try {
		if (isMainThread && !process.env.HARPER_SAFE_MODE) {
			interruptedActivationFailures = await recoverInterruptedActivations(
				configUtils.getConfigPath(CONFIG_PARAMS.COMPONENTSROOT),
				publishComponentConfigEntry
			);
		}
	} catch (error) {
		console.error(errorForLog(error));
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
