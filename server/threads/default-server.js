const env = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
module.exports = {
	startDefaultServer,
}
function startDefaultServer() {
	require('../harperdb/hdbServer').hdbServer();
	require('../../resources/resource-server').startServer({
		path: '/home/kzyp/dev/hdapp-template',
	});
	require('../../resources/graphql').registerGraphQL();
	require('../../resources/secure-js').registerJavaScript();
/*	const custom_func_enabled = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY);
	if (custom_func_enabled) require('../customFunctions/customFunctionsServer').customFunctionsServer();*/
}