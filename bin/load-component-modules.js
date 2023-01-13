const { initTables } = require('../resources/database');

const default_components = [
	{ module: '/resources/resource-server.ts', port: 9926 },
	{ module: '/resources/graphql.ts' },
	{ module: '/resources/secure-js.ts' },
	{ module: '/server/harperdb/hdbServer.js', port: 9925 },
	{ module: '/server/customFunctions/customFunctionsServer.js', port: 9926 },
];
async function loadComponentModules(components = default_components) {
	let tables = initTables();
	for (let { module: module_id, port } of default_components) {
		console.log('loading', module_id);
		let component = require('..' + module_id);
		console.log('loaded', module_id);
		console.log({component})
		try {
			await component.start({ port, tables });
		} catch(error) {
			console.error('Error loading component', error, module_id);
		}
	}
}
module.exports = {
	loadComponentModules
};