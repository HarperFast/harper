const { isMainThread } = require('worker_threads');
const socket_router = require('../server/threads/socket-router');
/*require('ts-node').register({
	project: join(PACKAGE_ROOT, 'tsconfig.json'),
});*/
const { getTables } = require('../resources/database');

const default_components = [
	{ module: '/mqtt/broker.js', port: 1883 },
	{ module: '/resources/graphql.js' },
	{ module: '/resources/resource-server.js', port: 9926 },
	{ module: '/resources/js-resource.js' },
	{ module: '/server/harperdb/hdbServer.js', port: 9925 },
	{ module: '/server/customFunctions/customFunctionsServer.js', port: 9926 },
];
async function loadComponentModules(components = default_components) {
	let tables = getTables();
	let ports_started = [];
	for (let { module: module_id, port } of default_components) {
		let component = require('..' + module_id);
		try {
			if (isMainThread) {
				if (component.startOnMainThread) await component.startOnMainThread();
				if (port && !ports_started.includes(port)) {
					ports_started.push(port);
					socket_router.startSocketServer(port);
				}
			} else await component.start({ port, tables });
		} catch (error) {
			console.error('Error loading component', error, module_id);
		}
	}
}
module.exports.loadComponentModules = loadComponentModules;
