'use strict';

const env = require('../../../utility/environment/environmentManager');
env.initSync();
const { CONFIG_PARAMS } = require('../../../utility/hdbTerms');

/**
 * Builds CORS options object to pass to cors plugin when/if it needs to be registered with Fastify
 *
 * @returns {{credentials: boolean, origin: boolean, allowedHeaders: [string, string]}}
 */
function getCORSOptions() {
	let props_cors_accesslist = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_CORSACCESSLIST);
	let props_cors = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_CORS);
	let cors_options;
	if (props_cors) {
		cors_options = {
			origin: true,
			allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
			credentials: false,
		};
		if (props_cors_accesslist && props_cors_accesslist.length > 0 && props_cors_accesslist[0] !== null) {
			cors_options.origin = (origin, callback) => {
				return callback(null, props_cors_accesslist.indexOf(origin) !== -1);
			};
		}
	}
	return cors_options;
}

module.exports = getCORSOptions;
