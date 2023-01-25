const { isMainThread } = require('worker_threads');
const { PACKAGE_ROOT } = require('../utility/hdbTerms');
const { join } = require('path');

/*require('ts-node').register({
	project: join(PACKAGE_ROOT, 'tsconfig.json'),
});*/
const { getTables } = require('../resources/database');

const default_components = [
	{ module: '/resources/resource-server.js', port: 9926 },
	{ module: '/resources/graphql.js' },
	{ module: '/resources/secure-js.js' },
	{ module: '/server/harperdb/hdbServer.js', port: 9925 },
	{ module: '/server/customFunctions/customFunctionsServer.js', port: 9926 },
];
async function loadComponentModules(components = default_components) {
	let tables = getTables();
	for (let { module: module_id, port } of default_components) {
		console.log('loading', module_id);
		let component = require('..' + module_id);
		console.log('loaded', module_id);
		console.log({component})
		try {
			if (isMainThread) {
				if (component.startOnMainThread)
					await component.startOnMainThread();
			} else
				await component.start({ port, tables });
		} catch(error) {
			console.error('Error loading component', error, module_id);
		}
	}
}
module.exports = {
	loadComponentModules
};