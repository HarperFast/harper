const { isMainThread } = require('worker_threads');
const { getTables } = require('../resources/databases.ts');
const { loadComponentDirectories, loadComponent } = require('../components/componentLoader.ts');
const { resetResources } = require('../resources/Resources.ts');
const configUtils = require('../config/configUtils.js');
const { dirname } = require('path');
const { loadCertificates } = require('../security/keys.js');
const { installApplications } = require('../components/Application.ts');

let loadedComponents = new Map();
/**
 * This is main entry point for loading the main set of global server modules that power HarperDB.
 * @returns {Promise<void>}
 */
async function loadRootComponents(isWorkerThread = false) {
	try {
		if (isMainThread) await installApplications();
	} catch (error) {
		console.error(error);
	}

	let resources = resetResources();
	getTables();
	resources.isWorker = isWorkerThread;

	await loadCertificates();
	// the HarperDB root component
	await loadComponent(dirname(configUtils.getConfigFilePath()), resources, 'hdb', true, loadedComponents);
	// once the global plugins are loaded, we now load all the CF and run applications (and their components)
	await loadComponentDirectories(loadedComponents, resources);
	let allReady = [];
	for (let [serverModule] of loadedComponents) {
		if (serverModule.ready) allReady.push(serverModule.ready());
	}
	if (allReady.length > 0) await Promise.all(allReady);
}

module.exports.loadRootComponents = loadRootComponents;
