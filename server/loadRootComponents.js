const { isMainThread } = require('worker_threads');
const { getTables } = require('../resources/databases.ts');
const { loadComponentDirectories, loadComponent } = require('../components/componentLoader.ts');
const { resetResources } = require('../resources/Resources.ts');
const configUtils = require('../config/configUtils.ts');
const { dirname } = require('path');
const { loadCertificates } = require('../security/keys.ts');
const { installApplications } = require('../components/Application.ts');

let loadedComponents = new Map();
/**
 * This is main entry point for loading the main set of global server modules that power Harper.
 * @returns {Promise<void>}
 */
async function loadRootComponents(isWorkerThread = false) {
	// TEMP #1616-debug (revert before merge): per-thread view of the resolved config at load time
	try {
		const cfg = configUtils.getConfigObj();
		console.error(
			`[1616-debug] loadRootComponents entry isWorker=${isWorkerThread} modelsGateway=${JSON.stringify(cfg?.modelsGateway)}`
		);
	} catch (e) {
		console.error(`[1616-debug] loadRootComponents getConfigObj failed: ${e.message}`);
	}
	try {
		if (isMainThread && !process.env.HARPER_SAFE_MODE) await installApplications();
	} catch (error) {
		console.error(error);
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
		await loadComponentDirectories(loadedComponents, resources);
	}
	let allReady = [];
	for (let [serverModule] of loadedComponents) {
		if (serverModule.ready) allReady.push(serverModule.ready());
	}
	if (allReady.length > 0) await Promise.all(allReady);
}

module.exports.loadRootComponents = loadRootComponents;
