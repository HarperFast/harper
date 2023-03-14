const { isMainThread } = require('worker_threads');
const socket_router = require('./threads/socketRouter');
const hdb_terms = require('../utility/hdbTerms');
const operationsServer = require('./operationsServer');
const basicAuth = require('../security/auth');
const { getTables } = require('../resources/tableLoader');
const { loadApplications } = require('../apps/applicationsLoader');
const env = require('../utility/environment/environmentManager');
const { secureImport } = require('../security/jsLoader');
const { resetResources } = require('../resources/Resources');
const mqtt = require('mqtt');
const { server } = require('./Server');

const CORE_PLUGINS = {
	'app-server': {}, // this is intended to be the default http handler for http-based plugins
	'operations-server': operationsServer,
	'auth': basicAuth,
	// 'NATS-cluster':..
	mqtt,
};
let loaded_server_modules = new Map();
const default_server_modules = [
	{ module: 'mqtt', port: 1883, secure: true },
	{ module: 'app-server', port: 9926 },
	{ module: 'operations-server', port: 9925 },
	// 'NATS-cluster':..
	{ module: 'auth' },
];

/**
 * This is main entry point for loading the main set of global server modules that power HarperDB.
 * @param server_modules
 * @returns {Promise<void>}
 */
async function loadServerModules(server_modules = default_server_modules) {
	let tables = getTables();
	let ports_started = [];
	let resources = resetResources();
	for (let server_module_definition of default_server_modules) {
		let { module: module_id, port } = server_module_definition;
		// use predefined core plugins or use the secure/sandbox loader (if configured)
		let server_module = CORE_PLUGINS[module_id] || (await secureImport(module_id));
		try {
			// start each server_module
			if (isMainThread) {
				if (server_module.startOnMainThread) await server_module.startOnMainThread(server_module_definition);
				if (port && !ports_started.includes(port)) {
					// if there is a TCP port associated with the plugin, we set up the routing on the main thread for it
					ports_started.push(port);
					const session_affinity = env.get(hdb_terms.CONFIG_PARAMS.HTTP_SESSION_AFFINITY);
					socket_router.startSocketServer(port, session_affinity);
				}
			} else if (server_module.start)
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
