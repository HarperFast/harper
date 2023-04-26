const { isMainThread } = require('worker_threads');
const socket_router = require('./threads/socketRouter');
const hdb_terms = require('../utility/hdbTerms');
const operationsServer = require('./operationsServer');
const auth = require('../security/auth');
const natsReplicator = require('../server/nats/natsReplicator');
const { getTables } = require('../resources/tableLoader');
const { loadApplications } = require('../apps/applicationsLoader');
const env = require('../utility/environment/environmentManager');
const { secureImport } = require('../security/jsLoader');
const { resetResources } = require('../resources/Resources');
const mqtt = require('./mqtt');
const { server } = require('./Server');
const config_utils = require('../config/configUtils');
const { CONFIG_PARAMS } = require('../utility/hdbTerms');

/**
 * Gets all default and custom server modules from harperdb-config
 * @returns {[{server_mods}]}
 */
function getServerModules() {
	const server_modules = [
		{ module: 'operations-server', port: env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT), plugin: operationsServer },
		{
			module: 'mqtt',
			port: env.get(CONFIG_PARAMS.MQTT_PORT),
			webSocket: env.get(CONFIG_PARAMS.MQTT_WEBSOCKET),
			plugin: mqtt,
		},
		{ module: 'app-server', port: env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_PORT), plugin: {} },
		{ module: 'auth', port: 'all' },
	];

	if (env.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
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
	let tables = getTables();
	let ports_started = [];
	let resources = resetResources();
	resources.isWorker = is_worker_thread;
	const server_modules = getServerModules();
	for (let server_module_definition of server_modules) {
		let { module: module_id, port, plugin } = server_module_definition;
		// use predefined core plugins or use the secure/sandbox loader (if configured)
		let server_module = plugin || (await secureImport(module_id));
		try {
			// start each server_module
			if (isMainThread) {
				if (server_module.startOnMainThread) await server_module.startOnMainThread(server_module_definition);
				if (+port && !ports_started.includes(port)) {
					// if there is a TCP port associated with the plugin, we set up the routing on the main thread for it
					ports_started.push(port);
					const session_affinity = env.get(hdb_terms.CONFIG_PARAMS.HTTP_SESSION_AFFINITY);
					socket_router.startSocketServer(port, session_affinity);
				}
			}
			if (is_worker_thread && server_module.start)
				// on child threads, we can connect to a port that the main thread is routing
				// (we can't start our own)
				await server_module.start({ server, resources, ...server_module_definition });
			loaded_server_modules.set(server_module, true);
		} catch (error) {
			console.error('Error loading server_module', error, module_id);
		}
	}
	// once the global plugins are loaded, we now load all the applications (and their plugins)
	await loadApplications(loaded_server_modules, resources);
	let all_ready = [];
	for (let [server_module] of loaded_server_modules) {
		if (server_module.ready) all_ready.push(server_module.ready());
	}
	if (all_ready.length > 0) await Promise.all(all_ready);
}

module.exports.loadServerModules = loadServerModules;