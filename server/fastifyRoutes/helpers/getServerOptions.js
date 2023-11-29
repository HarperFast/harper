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
	const server_timeout = env.get(CONFIG_PARAMS.HTTP_TIMEOUT);
	const keep_alive_timeout = env.get(CONFIG_PARAMS.HTTP_KEEPALIVETIMEOUT);
	return {
		bodyLimit: REQ_MAX_BODY_SIZE,
		connectionTimeout: server_timeout,
		keepAliveTimeout: keep_alive_timeout,
		return503OnClosing: false,
		forceCloseConnections: true,
		ignoreTrailingSlash: true,
		// http2: is_https, // for now we are not enabling HTTP/2 since it seems to show slower performance
		https: is_https /* && {
			allowHTTP1: true,
		},*/,
	};
}

module.exports = getServerOptions;
