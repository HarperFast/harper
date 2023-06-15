const { isMainThread } = require('worker_threads');
const socket_router = require('./threads/socketRouter');
const hdb_terms = require('../utility/hdbTerms');
const operationsServer = require('./operationsServer');
const auth = require('../security/auth');
const natsReplicator = require('../server/nats/natsReplicator');
const { getTables } = require('../resources/databases');
const { loadApplications, loadComponent } = require('../apps/applicationsLoader');
const env = require('../utility/environment/environmentManager');
const { secureImport } = require('../security/jsLoader');
const { resetResources } = require('../resources/Resources');
const install_apps = require('../apps/installApps');
const mqtt = require('./mqtt');
const { server } = require('./Server');
const config_utils = require('../config/configUtils');
const { CONFIG_PARAMS } = require('../utility/hdbTerms');
const { join, dirname } = require('path');
const { parseDocument } = require('yaml');
let loaded_components = new Map();
/**
 * Gets all default and custom server modules from harperdb-config
 * @returns {[{server_mods}]}
 */
function getServerModules() {
	const server_modules = [
		{ module: 'auth', port: 'all', plugin: auth },
		{
			module: 'operations-server',
			[env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_HTTPS) ? 'securePort' : 'port']:
				env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT) || 9925,
			plugin: operationsServer,
		},
		{
			module: 'mqtt',
			port: env.get(CONFIG_PARAMS.MQTT_PORT),
			securePort: env.get(CONFIG_PARAMS.MQTT_SECUREPORT),
			webSocket: env.get(CONFIG_PARAMS.MQTT_WEBSOCKET),
			requireAuthentication: env.get(CONFIG_PARAMS.MQTT_REQUIREAUTHENTICATION),
			plugin: mqtt,
		},
	];

	if (env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_ENABLED)) {
		server_modules.push({
			module: 'app-server',
			[env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HTTPS) ? 'securePort' : 'port']:
				env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_PORT) || 9926,
			plugin: {},
		});
	}

	if (env.get(CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		server_modules.push({ module: 'nats-replication', plugin: natsReplicator });
	}

	const plugins_config = config_utils.readConfigFile()[CONFIG_PARAMS.SERVER_PLUGINS];
	for (const plugin in plugins_config) {
		server_modules.push({
			module: plugin,
			...plugins_config[plugin],
		});
	}

	return server_modules;
}

/**
 * This is main entry point for loading the main set of global server modules that power HarperDB.
 * @returns {Promise<void>}
 */
async function loadServerModules(is_worker_thread = false) {
	if (isMainThread) await install_apps();

	let ports_started = [];
	let resources = resetResources();
	getTables();
	resources.isWorker = is_worker_thread;
	// the HarperDB root component
	await loadComponent(dirname(config_utils.getConfigFilePath()), resources, 'hdb', true, loaded_components);
	// once the global plugins are loaded, we now load all the CF and run applications (and their components)
	await loadApplications(loaded_components, resources);
	let all_ready = [];
	for (let [server_module] of loaded_components) {
		if (server_module.ready) all_ready.push(server_module.ready());
	}
	if (all_ready.length > 0) await Promise.all(all_ready);
}

module.exports.loadServerModules = loadServerModules;
function parseYamlDoc(file_path) {
	return YAML.parseDocument(fs.readFileSync(file_path, 'utf8'), { simpleKeys: true });
}
