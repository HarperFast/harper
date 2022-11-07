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
			allowHTTP1: true, // Support both HTTPS/1 and /2
			key: fs.readFileSync(`${privateKey}`),
			cert: fs.readFileSync(`${certificate}`),
		};
		// ALPN negotiation will not upgrade non-TLS HTTP/1, so we only turn on HTTP/2 when we have secure HTTPS,
		// plus browsers do not support unsecured HTTP/2, so there isn't a lot of value in trying to use insecure HTTP/2.
		server_opts.http2 = true;
	}

	return server_opts;
}

module.exports = getServerOptions;
