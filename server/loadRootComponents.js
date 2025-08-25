const { isMainThread } = require('worker_threads');
const { getTables, getDatabases, table } = require('../resources/databases.ts');
const { loadComponentDirectories, loadComponent } = require('../components/componentLoader.ts');
const { resetResources } = require('../resources/Resources.ts');
const installComponents = require('../components/installComponents.js');
const configUtils = require('../config/configUtils.js');
const { dirname } = require('path');
const { getConnection } = require('./nats/utility/natsUtils.js');
const envMgr = require('../utility/environment/environmentManager.js');
const { CONFIG_PARAMS } = require('../utility/hdbTerms.ts');
const { loadCertificates } = require('../security/keys.js');
const { loadAndWatchLicensesDir } = require('../resources/usageLicensing');

let loadedComponents = new Map();
/**
 * This is main entry point for loading the main set of global server modules that power HarperDB.
 * @returns {Promise<void>}
 */
async function loadRootComponents(isWorkerThread = false) {
	// Create and cache the nats client connection
	if (!isMainThread && envMgr.get(CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		// The await is purposely omitted here so that it doesn't slow down startup time
		getConnection();
	}
	try {
		if (isMainThread) await installComponents();
	} catch (error) {
		console.error(error);
	}

	let resources = resetResources();
	getTables();
	resources.isWorker = isWorkerThread;

	if (isMainThread) {
		await loadAndWatchLicensesDir();
	}

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
