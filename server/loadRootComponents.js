const { isMainThread } = require('worker_threads');
const { getTables, getDatabases, table } = require('../resources/databases');
const { loadComponentDirectories, loadComponent } = require('../components/componentLoader');
const { resetResources } = require('../resources/Resources');
const install_components = require('../components/installComponents');
const config_utils = require('../config/configUtils');
const { dirname } = require('path');
const { getConnection } = require('./nats/utility/natsUtils');
const env_mgr = require('../utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('../utility/hdbTerms');
const { CERT_CONFIG_NAME_MAP } = require('../utility/terms/certificates');
const { readFileSync, existsSync } = require('fs');
const { loadCertificates } = require('../security/keys');

let loaded_components = new Map();
/**
 * This is main entry point for loading the main set of global server modules that power HarperDB.
 * @returns {Promise<void>}
 */
async function loadRootComponents(is_worker_thread = false) {
	// Create and cache the nats client connection
	if (!isMainThread && env_mgr.get(CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		// The await is purposely omitted here so that is doesnt slow down startup time
		getConnection();
	}
	try {
		if (isMainThread) await install_components();
	} catch (error) {
		console.error(error);
	}

	let resources = resetResources();
	getTables();
	resources.isWorker = is_worker_thread;
	await loadCertificates();
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
/*function loadCertificates() {
	const CERTIFICATE_CONFIGS = [
		CONFIG_PARAMS.TLS_CERTIFICATE,
		CONFIG_PARAMS.TLS_CERTIFICATEAUTHORITY,
		CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATE,
		CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATEAUTHORITY,
	];
	const certificate_table = getDatabases()['system']['hdb_certificate'];
	let promise;
	for (let config_key of CERTIFICATE_CONFIGS) {
		const path = env_mgr.get(config_key);
		if (path && existsSync(path)) {
			promise = certificate_table.put({
				name: CERT_CONFIG_NAME_MAP[config_key],
				uses: ['https', ...(config_key.includes('operations') ? ['operations'] : [])],
				certificate: readFileSync(path, 'utf8'),
				is_authority: config_key.includes('uthority'),
			});
		}
	}
	return promise;
}*/

module.exports.loadRootComponents = loadRootComponents;
