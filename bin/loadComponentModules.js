const { isMainThread } = require('worker_threads');
const socket_router = require('../server/threads/socketRouter');
const hdb_terms = require('../utility/hdbTerms');
const operationsServer = require('../server/harperdb/operationsServer');
const basicAuth = require('../security/basicAuth');
const { server } = require('../index');
const { getTables } = require('../resources/database');
const { loadCustomFunctions } = require('../server/customFunctions/customFunctionsLoader');
const env = require('../utility/environment/environmentManager');
const { secureImport } = require('../resources/jsLoader');
const { Resources } = require('../resources/Resources');

const CORE_PLUGINS = {
	'app-server': {},
	'operations-server': operationsServer,
	'auth': basicAuth,
};
let loaded_plugins = new Map();
const default_components = [
	//{ module: '/mqtt/broker.js', port: 1883 },
	{ module: 'app-server', port: 9926 },
	{ module: 'operations-server', port: 9925 },
	{ module: 'auth' },
];
async function loadComponentModules(components = default_components) {
	let tables = getTables();
	let ports_started = [];
	let resources = new Resources();
	for (let { module: module_id, port } of default_components) {
		let component = CORE_PLUGINS[module_id] || (await secureImport(module_id));
		try {
			if (isMainThread) {
				if (component.startOnMainThread) await component.startOnMainThread();
				if (port && !ports_started.includes(port)) {
					ports_started.push(port);
					const session_affinity = env.get(hdb_terms.CONFIG_PARAMS.HTTP_SESSION_AFFINITY);
					socket_router.startSocketServer(port, session_affinity);
				}
			} else if (component.start) await component.start({ server, port, resources });
			loaded_plugins.set(component, true);
		} catch (error) {
			console.error('Error loading component', error, module_id);
		}
	}
	await loadCustomFunctions(loaded_plugins, resources);
	let all_ready = [];
	for (let [component] of loaded_plugins) {
		if (component.ready) all_ready.push(component.ready());
	}
	if (all_ready.length > 0) await Promise.all(all_ready);
}
module.exports.loadComponentModules = loadComponentModules;
