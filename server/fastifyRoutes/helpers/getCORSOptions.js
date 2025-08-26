'use strict';

const env = require('../../../utility/environment/environmentManager.js');
env.initSync();
const { CONFIG_PARAMS } = require('../../../utility/hdbTerms.ts');

/**
 * Builds CORS options object to pass to cors plugin when/if it needs to be registered with Fastify
 *
 * @returns {{credentials: boolean, origin: boolean, allowedHeaders: [string, string]}}
 */
function getCORSOptions() {
	let propsCorsAccesslist = env.get(CONFIG_PARAMS.HTTP_CORSACCESSLIST);
	let propsCors = env.get(CONFIG_PARAMS.HTTP_CORS);
	let corsOptions;
	if (propsCors) {
		corsOptions = {
			origin: true,
			allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
			credentials: false,
		};
		if (
			propsCorsAccesslist &&
			propsCorsAccesslist.length > 0 &&
			propsCorsAccesslist[0] !== null &&
			propsCorsAccesslist[0] !== '*'
		) {
			corsOptions.origin = (origin, callback) => {
				return callback(null, propsCorsAccesslist.indexOf(origin) !== -1);
			};
		}
	}
	return corsOptions;
}

module.exports = getCORSOptions;
