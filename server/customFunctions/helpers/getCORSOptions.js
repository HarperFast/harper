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
	let props_cors_whitelist = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_CORSWHITELIST);
	let props_cors = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_CORS);
	let cors_options;
	if (props_cors) {
		cors_options = {
			origin: true,
			allowedHeaders: ['Content-Type', 'Authorization'],
			credentials: false,
		};
		if (props_cors_whitelist && props_cors_whitelist.length > 0 && props_cors_whitelist[0] !== null) {
			let whitelist = props_cors_whitelist.split(',');
			cors_options.origin = (origin, callback) => {
				if (whitelist.indexOf(origin) !== -1) {
					return callback(null, true);
				}
				return callback(new Error(`domain ${origin} is not whitelisted`));
			};
		}
	}
	return cors_options;
}

module.exports = getCORSOptions;
