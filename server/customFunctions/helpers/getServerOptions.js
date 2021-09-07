'use strict';

const fs = require('fs');
const env = require('../../../utility/environment/environmentManager');
env.initSync();
const terms = require('../../../utility/hdbTerms');

// eslint-disable-next-line no-magic-numbers
const REQ_MAX_BODY_SIZE = 1024 * 1024 * 1024; //this is 1GB in bytes

const { HDB_SETTINGS_NAMES, HDB_SETTINGS_DEFAULT_VALUES } = terms;
const PROPS_SERVER_TIMEOUT_KEY = HDB_SETTINGS_NAMES.SERVER_TIMEOUT_KEY;
const PROPS_SERVER_KEEP_ALIVE_TIMEOUT_KEY = HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY;
const PROPS_PRIVATE_KEY = HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY;
const PROPS_CERT_KEY = HDB_SETTINGS_NAMES.CERT_KEY;

const DEFAULT_SERVER_TIMEOUT = HDB_SETTINGS_DEFAULT_VALUES[PROPS_SERVER_TIMEOUT_KEY];
const DEFAULT_KEEP_ALIVE_TIMEOUT = HDB_SETTINGS_DEFAULT_VALUES[PROPS_SERVER_KEEP_ALIVE_TIMEOUT_KEY];

/*
 * Builds server options object to pass to Fastify when using server factory.
 *
 * @param is_https
 * @returns {{ keepAliveTimeout: *, bodyLimit: number, connectionTimeout: *, ignoreTrailingSlash: boolean, https: Object }}
 */
function getServerOptions(is_https) {
	const server_timeout = env.get(PROPS_SERVER_TIMEOUT_KEY) ? env.get(PROPS_SERVER_TIMEOUT_KEY) : DEFAULT_SERVER_TIMEOUT;
	const keep_alive_timeout = env.get(PROPS_SERVER_KEEP_ALIVE_TIMEOUT_KEY)
		? env.get(PROPS_SERVER_KEEP_ALIVE_TIMEOUT_KEY)
		: DEFAULT_KEEP_ALIVE_TIMEOUT;

	const server_opts = {
		bodyLimit: REQ_MAX_BODY_SIZE,
		connectionTimeout: server_timeout,
		keepAliveTimeout: keep_alive_timeout,
		ignoreTrailingSlash: true,
	};

	if (is_https) {
		const privateKey = env.get(PROPS_PRIVATE_KEY);
		const certificate = env.get(PROPS_CERT_KEY);
		server_opts.https = {
			key: fs.readFileSync(`${privateKey}`),
			cert: fs.readFileSync(`${certificate}`),
		};
	}

	return server_opts;
}

module.exports = getServerOptions;
