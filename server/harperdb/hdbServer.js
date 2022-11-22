'use strict';

const cluster = require('cluster');
const env = require('../../utility/environment/environmentManager');
env.initSync();
const terms = require('../../utility/hdbTerms');
const util = require('util');
const harper_logger = require('../../utility/logging/harper_logger');

const fs = require('fs');
const fastify = require('fastify');

const pjson = require('../../package.json');
const fastify_cors = require('@fastify/cors');
const fastify_compress = require('@fastify/compress');
const fastify_static = require('@fastify/static');
const fastify_serializer = require('@fastify/accepts-serializer');
const {pack, unpack} = require('msgpackr');
const request_time_plugin = require('../serverHelpers/requestTimePlugin');
const guidePath = require('path');
const { PACKAGE_ROOT } = require('../../utility/hdbTerms');
const global_schema = require('../../utility/globalSchema');
const common_utils = require('../../utility/common_utils');
const user_schema = require('../../security/user');
const hdb_license = require('../../utility/registration/hdb_license');
const { isMainThread } = require('worker_threads');
const { registerServer } = require('../threads/thread-http-server');
const { toCsvStream } = require('../../data_layer/export');
const p_schema_to_global = util.promisify(global_schema.setSchemaDataToGlobal);

const {
	authHandler,
	handlePostRequest,
	handleServerUncaughtException,
	serverErrorHandler,
	reqBodyValidationHandler,
	handleBeforeExit,
	handleExit,
	handleSigint,
	handleSigquit,
	handleSigterm,
} = require('../serverHelpers/serverHandlers');
const net = require("net");

const REQ_MAX_BODY_SIZE = 1024 * 1024 * 1024; //this is 1GB in bytes
const TRUE_COMPARE_VAL = 'TRUE';

const {HDB_SETTINGS_NAMES} = terms;
const PROPS_CORS_KEY = HDB_SETTINGS_NAMES.CORS_ENABLED_KEY;
const PROPS_CORS_ACCESSLIST_KEY = 'CORS_ACCESSLIST';
const PROPS_SERVER_TIMEOUT_KEY = HDB_SETTINGS_NAMES.SERVER_TIMEOUT_KEY;
const PROPS_SERVER_KEEP_ALIVE_TIMEOUT_KEY = HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY;
const PROPS_HEADER_TIMEOUT_KEY = HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY;
const PROPS_PRIVATE_KEY = HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY;
const PROPS_CERT_KEY = HDB_SETTINGS_NAMES.CERT_KEY;
const PROPS_HTTP_SECURE_ON_KEY = HDB_SETTINGS_NAMES.HTTP_SECURE_ENABLED_KEY;
const PROPS_SERVER_PORT_KEY = HDB_SETTINGS_NAMES.SERVER_PORT_KEY;

let server = undefined;

module.exports = {
	hdbServer,
};
/**
 * Builds a HarperDB server.
 * @returns {Promise<void>}
 */
async function hdbServer() {
	try {
		harper_logger.info('In Fastify server' + process.cwd());
		harper_logger.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
		harper_logger.debug(`HarperDB server process ${process.pid} starting up.`);

		global.clustering_on = false;
		global.isMaster = cluster.isMaster;

		process.on('uncaughtException', handleServerUncaughtException);
		process.on('beforeExit', handleBeforeExit);
		process.on('exit', handleExit);		process.on('SIGINT', handleSigint);
		process.on('SIGQUIT', handleSigquit);
		process.on('SIGTERM', handleSigterm);

		await setUp();

		const props_http_secure_on = env.get(PROPS_HTTP_SECURE_ON_KEY);
		const props_server_port = env.get(PROPS_SERVER_PORT_KEY);
		const is_https =
			props_http_secure_on &&
			(props_http_secure_on === true || props_http_secure_on.toUpperCase() === TRUE_COMPARE_VAL);

		//generate a Fastify server instance
		server = buildServer(is_https);

		//make sure the process waits for the server to be fully instantiated before moving forward
		await server.ready();

		const server_type = is_https ? 'HTTPS' : 'HTTP';
		try {
			// now that server is fully loaded/ready, start listening on port provided in config settings or just use
			// zero to wait for sockets from the main thread
			registerServer(terms.SERVICES.HDB_CORE, server);
			if (isMainThread) {
				await server.listen({ port: props_server_port, host: '::' });
				harper_logger.info(`HarperDB ${pjson.version} ${server_type} Server running on port ${props_server_port}`);
			} else if (!server.server.closeIdleConnections) {
				// before Node v18, closeIdleConnections is not available, and we have to setup a listener for fastify
				// to handle closing by setting up the dynamic port
				await server.listen({ port: 0, host: '::' });
			}
		} catch (err) {
			server.close();
			harper_logger.error(err);
			harper_logger.error(`Error configuring ${server_type} server`);
			throw err;
		}
	} catch (err) {
		harper_logger.error(`Failed to build server on ${process.pid}`);
		harper_logger.fatal(err);
		process.exit(1);
	}
}

/**
 * Makes sure global values are set and that clustering connections are set/ready before server starts.
 * @returns {Promise<void>}
 */
async function setUp() {
	try {
		harper_logger.trace('Configuring HarperDB process.');
		await p_schema_to_global();
		await user_schema.setUsersToGlobal();
		await hdb_license.getLicense();
	} catch (e) {
		harper_logger.error(e);
	}
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
			reply.code(404).send({error: 'Not Found', statusCode: 404});
		});
		done();
	});

	app.register(request_time_plugin);

	// This handles all get requests for the studio
	app.register(fastify_compress);
	app.register(fastify_static, {root: guidePath.join(__dirname, '../../docs')});
	app.register(fastify_serializer);
	app.addContentTypeParser('application/x-msgpack', {parseAs: 'buffer'}, (req, body, done) => {
		try {
			done(null, unpack(body));
		} catch (error) {
			error.statusCode = 400;
			done(error);
		}
	});

	let studio_on = env.get(terms.HDB_SETTINGS_NAMES.LOCAL_STUDIO_ON);
	app.get('/', function (req, res) {
		//if the local studio is enabled we will serve it, otherwise return 404
		if (!common_utils.isEmpty(studio_on) && studio_on.toString().toLowerCase() === 'true') {
			return res.sendFile('index.html');
		}
		return res.callNotFound();
	});

	// This handles all POST requests
	app.post(
		'/',
		{
			preValidation: [reqBodyValidationHandler, authHandler],
			config: {
				serializers: [
					{
						regex: /^application\/(x-)?msgpack$/,
						serializer: pack,
					},
					{
						regex: /^text\/csv$/,
						serializer: function(data) {
							this.header('Content-Disposition', 'attachment; filename="data.csv"');
							return toCsvStream(data);
						},
					},
				],
			},
		},
		async function (req, res) {
			//if no error is thrown below, the response 'data' returned from the handler will be returned with 200/OK code
			return handlePostRequest(req);
		}
	);

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
	const server_timeout = env.get(PROPS_SERVER_TIMEOUT_KEY);
	const keep_alive_timeout = env.get(PROPS_SERVER_KEEP_ALIVE_TIMEOUT_KEY);
	const server_opts = {
		bodyLimit: REQ_MAX_BODY_SIZE,
		connectionTimeout: server_timeout,
		keepAliveTimeout: keep_alive_timeout,
	};

	if (is_https) {
		const privateKey = env.get(PROPS_PRIVATE_KEY);
		const certificate = env.get(PROPS_CERT_KEY);
		const credentials = {
			allowHTTP1: true, // Support both HTTPS/1 and /2
			key: fs.readFileSync(`${privateKey}`),
			cert: fs.readFileSync(`${certificate}`)
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
	let props_cors = env.get(PROPS_CORS_KEY);
	let props_cors_accesslist = env.get(PROPS_CORS_ACCESSLIST_KEY);
	let cors_options;

	if (props_cors && (props_cors === true || props_cors.toUpperCase() === TRUE_COMPARE_VAL)) {
		cors_options = {
			origin: true,
			allowedHeaders: ['Content-Type', 'Authorization'],
			credentials: false,
		};
		if (props_cors_accesslist && props_cors_accesslist.length > 0 && props_cors_accesslist[0] !== null) {
			let access_list = props_cors_accesslist.split(',');
			cors_options.origin = (origin, callback) => {
				if (access_list.indexOf(origin) !== -1) {
					return callback(null, true);
				}
				return callback(new Error(`domain ${origin} is not on access list`));
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
	return env.get(PROPS_HEADER_TIMEOUT_KEY);
}
