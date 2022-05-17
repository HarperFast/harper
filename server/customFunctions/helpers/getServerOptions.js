'use strict';

const fs = require('fs');
const env = require('../../../utility/environment/environmentManager');
env.initSync();
const { CONFIG_PARAMS } = require('../../../utility/hdbTerms');

// eslint-disable-next-line no-magic-numbers
const REQ_MAX_BODY_SIZE = 1024 * 1024 * 1024; //this is 1GB in bytes

/**
 * Builds server options object to pass to Fastify when using server factory.
 * @param is_https
 * @returns {{keepAliveTimeout: (*), bodyLimit: number, ignoreTrailingSlash: boolean, connectionTimeout: (*)}}
 */
function getServerOptions(is_https) {
	const server_timeout = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_TIMEOUT);
	const keep_alive_timeout = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_KEEPALIVETIMEOUT);
	const server_opts = {
		bodyLimit: REQ_MAX_BODY_SIZE,
		connectionTimeout: server_timeout,
		keepAliveTimeout: keep_alive_timeout,
		ignoreTrailingSlash: true,
	};

	if (is_https) {
		const privateKey = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_TLS_PRIVATEKEY);
		const certificate = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_TLS_CERTIFICATE);
		server_opts.https = {
			key: fs.readFileSync(`${privateKey}`),
			cert: fs.readFileSync(`${certificate}`),
		};
	}

	return server_opts;
}

module.exports = getServerOptions;
