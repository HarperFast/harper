const { isMainThread } = require('worker_threads');
const { getTables } = require('../resources/databases');
const { loadComponentDirectories, loadComponent } = require('../components/componentLoader');
const { resetResources } = require('../resources/Resources');
const install_components = require('../components/installComponents');
const config_utils = require('../config/configUtils');
const { dirname } = require('path');
const { getConnection } = require('./nats/utility/natsUtils');
const env_mgr = require('../utility/environment/environmentManager');
const hdb_terms = require('../utility/hdbTerms');

let loaded_components = new Map();
/**
 * This is main entry point for loading the main set of global server modules that power HarperDB.
 * @returns {Promise<void>}
 */
async function loadRootComponents(is_worker_thread = false) {
	// Create and cache the nats client connection
	if (!isMainThread && env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		// The await is purposely omitted here so that is doesnt slow down startup time
		getConnection();
	}

	if (isMainThread) await install_components();

	let resources = resetResources();
	getTables();
	resources.isWorker = is_worker_thread;
	// the HarperDB root component
	await loadComponent(dirname(config_utils.getConfigFilePath()), resources, 'hdb', true, loaded_components);
	// once the global plugins are loaded, we now load all the CF and run applications (and their components)
	await loadComponentDirectories(loaded_components, resources);
	let all_ready = [];
	for (let [server_module] of loaded_components) {
		if (server_module.ready) all_ready.push(server_module.ready());
	}
	if (all_ready.length > 0) await Promise.all(all_ready);
}

module.exports.loadRootComponents = loadRootComponents;
