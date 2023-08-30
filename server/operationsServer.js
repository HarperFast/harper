'use strict';

const cluster = require('cluster');
const env = require('../utility/environment/environmentManager');
env.initSync();
const terms = require('../utility/hdbTerms');
const util = require('util');
const harper_logger = require('../utility/logging/harper_logger');
const fs = require('fs');
const fastify = require('fastify');

const pjson = require('../package.json');
const fastify_cors = require('@fastify/cors');
const fastify_compress = require('@fastify/compress');
const fastify_static = require('@fastify/static');
const request_time_plugin = require('./serverHelpers/requestTimePlugin');
const guidePath = require('path');
const { PACKAGE_ROOT } = require('../utility/hdbTerms');
const global_schema = require('../utility/globalSchema');
const common_utils = require('../utility/common_utils');
const user_schema = require('../security/user');
const hdb_license = require('../utility/registration/hdb_license');
const { server: server_registration } = require('../server/Server');

const {
	authHandler,
	handlePostRequest,
	serverErrorHandler,
	reqBodyValidationHandler,
} = require('./serverHelpers/serverHandlers');
const net = require('net');
const { registerContentHandlers } = require('./serverHelpers/contentTypes');

const DEFAULT_HEADERS_TIMEOUT = 60000;
const REQ_MAX_BODY_SIZE = 1024 * 1024 * 1024; //this is 1GB in bytes
const TRUE_COMPARE_VAL = 'TRUE';

const { CONFIG_PARAMS } = terms;
let server;

module.exports = {
	hdbServer: operationsServer,
	start: operationsServer,
};
/**
 * Builds a HarperDB server.
 * @returns {Promise<void>}
 */
async function operationsServer(options) {
	try {
		harper_logger.info('In Fastify server' + process.cwd());
		harper_logger.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
		harper_logger.debug(`HarperDB server process ${process.pid} starting up.`);

		global.clustering_on = false;
		global.isMaster = cluster.isMaster;

		await setUp();
		const is_https = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT) != null;

		//generate a Fastify server instance
		server = buildServer(is_https);

		//make sure the process waits for the server to be fully instantiated before moving forward
		await server.ready();
		if (!options) options = {};
		options.isOperationsServer = true;
		// fastify can't clean up properly
		server.server.cantCleanupProperly = true;
		try {
			// now that server is fully loaded/ready, start listening on port provided in config settings or just use
			// zero to wait for sockets from the main thread
			server_registration.http(server.server, options);
			if (!server.server.closeIdleConnections) {
				// before Node v18, closeIdleConnections is not available, and we have to setup a listener for fastify
				// to handle closing by setting up the dynamic port
				await server.listen({ port: 0, host: '::' });
			}
		} catch (err) {
			server.close();
			harper_logger.error(err);
			harper_logger.error(`Error configuring operations server`);
			throw err;
		}
	} catch (err) {
		console.error(`Failed to build server on ${process.pid}`, err);
		harper_logger.fatal(err);
		process.exit(1);
	}
}

/**
 * Makes sure global values are set and that clustering connections are set/ready before server starts.
 * @returns {Promise<void>}
 */
async function setUp() {
	harper_logger.trace('Configuring HarperDB process.');
	global_schema.setSchemaDataToGlobal();
	await user_schema.setUsersToGlobal();
	await hdb_license.getLicense();
}

/**
 * This method configures and returns a Fastify server - for either HTTP or HTTPS  - based on the provided config settings
 *
 * @param is_https - <boolean> - type of communication protocol to build server for
 * @returns {FastifyInstance}
 */
function buildServer(is_https) {
	harper_logger.debug(`HarperDB process starting to build ${is_https ? 'HTTPS' : 'HTTP'} server.`);
	let server_opts = getServerOptions(is_https);
	const app = fastify(server_opts);
	//Fastify does not set this property in the initial app construction
	app.server.headersTimeout = getHeaderTimeoutConfig();

	// set top-level error handler for server - all errors caught/thrown within the API will bubble up to this
	// handler so they can be handled in a coordinated way
	app.setErrorHandler(serverErrorHandler);

	const cors_options = getCORSOpts();
	if (cors_options) {
		app.register(fastify_cors, cors_options);
	}

	app.register(function (instance, options, done) {
		instance.setNotFoundHandler(function (request, reply) {
			app.server.emit('unhandled', request.raw, reply.raw);
		});
		done();
	});

	app.register(request_time_plugin);

	// This handles all get requests for the studio
	app.register(fastify_compress);
	app.register(fastify_static, { root: PACKAGE_ROOT });
	registerContentHandlers(app);

	let studio_on = env.get(terms.HDB_SETTINGS_NAMES.LOCAL_STUDIO_ON);
	app.get('/', function (req, res) {
		//if the local studio is enabled we will serve it, otherwise return 404
		if (!common_utils.isEmpty(studio_on) && studio_on.toString().toLowerCase() === 'true') {
			return res.sendFile('studio/index.html');
		}
		return res.sendFile('studio/running.html');
	});

	// This handles all POST requests
	app.post(
		'/',
		{
			preValidation: [reqBodyValidationHandler, authHandler],
			config: { isOperation: true },
		},
		async function (req, res) {
			// if the operation is a restart, we have to tell the client not to use keep alive on this connection
			// anymore; it needs to be closed because this thread is going to be terminated
			if (req.body?.operation?.startsWith('restart')) res.header('Connection', 'close');
			//if no error is thrown below, the response 'data' returned from the handler will be returned with 200/OK code
			return handlePostRequest(req, res);
		}
	);
	app.get('/health', () => {
		return 'HarperDB is running.';
	});

	harper_logger.debug(`HarperDB process starting up ${is_https ? 'HTTPS' : 'HTTP'} server listener.`);

	return app;
}

/**
 * Builds server options object to pass to Fastify when using server factory.
 *
 * @param is_https
 * @returns {{keepAliveTimeout: *, bodyLimit: number, connectionTimeout: *}}
 */
function getServerOptions(is_https) {
	const server_timeout = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_TIMEOUT);
	const keep_alive_timeout = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT);
	const server_opts = {
		bodyLimit: REQ_MAX_BODY_SIZE,
		connectionTimeout: server_timeout,
		keepAliveTimeout: keep_alive_timeout,
		forceCloseConnections: true,
		return503OnClosing: false,
	};

	if (is_https) {
		const privateKey = env.get(CONFIG_PARAMS.OPERATIONSAPI_TLS_PRIVATEKEY);
		const certificate = env.get(CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATE);
		const certificateAuthority = env.get(CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATEAUTHORITY);
		const credentials = {
			allowHTTP1: true, // Support both HTTPS/1 and /2
			key: fs.readFileSync(privateKey),
			// if they have a CA, we append it, so it is included
			cert: fs.readFileSync(certificate) + (certificateAuthority ? '\n\n' + fs.readFileSync(certificateAuthority) : ''),
		};
		// ALPN negotiation will not upgrade non-TLS HTTP/1, so we only turn on HTTP/2 when we have secure HTTPS,
		// plus browsers do not support unsecured HTTP/2, so there isn't a lot of value in trying to use insecure HTTP/2.
		server_opts.http2 = true;
		server_opts.https = credentials;
	}

	return server_opts;
}

/**
 * Builds CORS options object to pass to cors plugin when/if it needs to be registered with Fastify
 *
 * @returns {{credentials: boolean, origin: boolean, allowedHeaders: [string, string]}}
 */
function getCORSOpts() {
	let props_cors = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORS);
	let props_cors_accesslist = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST);
	let cors_options;

	if (props_cors && (props_cors === true || props_cors.toUpperCase() === TRUE_COMPARE_VAL)) {
		cors_options = {
			origin: true,
			allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
			credentials: false,
		};
		if (
			props_cors_accesslist &&
			props_cors_accesslist.length > 0 &&
			props_cors_accesslist[0] !== null &&
			props_cors_accesslist[0] !== '*'
		) {
			cors_options.origin = (origin, callback) => {
				return callback(null, props_cors_accesslist.indexOf(origin) !== -1);
			};
		}
	}
	return cors_options;
}

/**
 * Returns header timeout value from config file or, if not entered, the default value
 *
 * @returns {*}
 */
function getHeaderTimeoutConfig() {
	return env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_HEADERSTIMEOUT) ?? DEFAULT_HEADERS_TIMEOUT;
}
