const { isMainThread } = require('worker_threads');
const socket_router = require('../server/threads/socketRouter');
const hdb_terms = require('../utility/hdbTerms');
const operationsServer = require('../server/harperdb/operationsServer');
const basicAuth = require('../security/basicAuth');
const { server } = require('../index');
const { getTables } = require('../resources/database');
const { loadApplications } = require('../server/customFunctions/applicationsLoader');
const env = require('../utility/environment/environmentManager');
const { secureImport } = require('../resources/jsLoader');
const { Resources } = require('../resources/Resources');

const CORE_PLUGINS = {
	'app-server': {}, // this is intended to be the default http handler for http-based plugins
	'operations-server': operationsServer,
	'auth': basicAuth,
};
let loaded_plugins = new Map();
const default_components = [
	//{ module: '/mqtt/broker.js', port: 1883 },
	//{ module: '/mqtt/broker.js', webSocket: true },
	{ module: 'app-server', port: 9926 },
	{ module: 'operations-server', port: 9925 },
	{ module: 'auth' },
];

/**
 * Load the main set of global component plugin modules
 * @param components
 * @returns {Promise<void>}
 */
async function loadComponentModules(components = default_components) {
	let tables = getTables();
	let ports_started = [];
	let resources = new Resources();
	for (let component_definition of default_components) {
		let { module: module_id, port } = component_definition;
		// use predefined core plugins or use the secure/sandbox loader (if configured)
		let component = CORE_PLUGINS[module_id] || (await secureImport(module_id));
		try {
			// start each component
			if (isMainThread) {
				if (component.startOnMainThread) await component.startOnMainThread(component_definition);
				if (port && !ports_started.includes(port)) {
					// if there is a TCP port associated with the plugin, we set up the routing on the main thread for it
					ports_started.push(port);
					const session_affinity = env.get(hdb_terms.CONFIG_PARAMS.HTTP_SESSION_AFFINITY);
					socket_router.startSocketServer(port, session_affinity);
				}
			} else if (component.start)
				// on child threads, we can connect to a port that the main thread is routing
				// (we can't start our own)
				await component.start({ server, resources, ...component_definition });
			loaded_plugins.set(component, true);
		} catch (error) {
			console.error('Error loading component', error, module_id);
		}
	}
	// once the global plugins are loaded, we now load all the applications (and their plugins)
	await loadApplications(loaded_plugins, resources);
	let all_ready = [];
	for (let [component] of loaded_plugins) {
		if (component.ready) all_ready.push(component.ready());
	}
	if (all_ready.length > 0) await Promise.all(all_ready);
}
module.exports.loadComponentModules = loadComponentModules;
