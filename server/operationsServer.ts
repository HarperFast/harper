import cluster from 'cluster';
import env from '../utility/environment/environmentManager';
env.initSync();
import * as terms from '../utility/hdbTerms';
import harper_logger from '../utility/logging/harper_logger';
import fastify, { FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastify_cors, { type FastifyCorsOptions } from '@fastify/cors';
import fastify_compress from '@fastify/compress';
import fastify_static from '@fastify/static';
import request_time_plugin from './serverHelpers/requestTimePlugin';
import guidePath from 'path';
import { PACKAGE_ROOT } from '../utility/packageUtils';
import global_schema from '../utility/globalSchema';
import common_utils from '../utility/common_utils';
import user_schema from '../security/user';
import hdb_license from '../utility/registration/hdb_license';
import { server as server_registration, type ServerOptions } from '../server/Server';
import {
	authHandler,
	handlePostRequest,
	serverErrorHandler,
	reqBodyValidationHandler,
} from './serverHelpers/serverHandlers';
import { registerContentHandlers } from './serverHelpers/contentTypes';

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
 */
async function operationsServer(options: ServerOptions) {
	try {
		harper_logger.debug('In Fastify server' + process.cwd());
		harper_logger.debug(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
		harper_logger.debug(`HarperDB server process ${process.pid} starting up.`);

		global.clustering_on = false;
		global.isMaster = cluster.isMaster;

		await setUp();
		// if we have a secure port, need to use the secure HTTP server for fastify (it can be used for HTTP as well)
		const is_https = options.securePort > 0;

		//generate a Fastify server instance
		server = buildServer(is_https);

		//make sure the process waits for the server to be fully instantiated before moving forward
		await server.ready();
		if (!options) options = {};
		options.isOperationsServer = true;
		// fastify can't clean up properly
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
 */
async function setUp() {
	harper_logger.trace('Configuring HarperDB process.');
	global_schema.setSchemaDataToGlobal();
	await user_schema.setUsersWithRolesCache();
	await hdb_license.getLicense();
}

interface PostBody {
	operation: string;
}

/**
 * This method configures and returns a Fastify server - for either HTTP or HTTPS  - based on the provided config settings
 */
function buildServer(is_https: boolean): FastifyInstance {
	harper_logger.debug(`HarperDB process starting to build ${is_https ? 'HTTPS' : 'HTTP'} server.`);
	const server_opts = getServerOptions(is_https);
	/*
	TODO: Eventually we may want to directly forward requests to fastify rather than having it create a
	(pseudo) server.
	let request_handler;
	server_opts.serverFactory = (handler) => {
		request_handler = (request) => {
			return handler(request[node_request_key], request[node_response_key]);
		};
		return { on() {} };
	};*/
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
	app.register(fastify_static, { root: guidePath.join(PACKAGE_ROOT, 'studio/build-local') });
	registerContentHandlers(app);

	const studio_on = env.get(terms.HDB_SETTINGS_NAMES.LOCAL_STUDIO_ON);
	app.get('/', function (req, res) {
		//if the local studio is enabled we will serve it, otherwise return 404
		if (!common_utils.isEmpty(studio_on) && studio_on.toString().toLowerCase() === 'true') {
			return res.sendFile('index.html');
		}
		return res.sendFile('running.html');
	});

	// This handles all POST requests
	app.post<{ Body: PostBody }>(
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

interface HttpServerOptions extends FastifyServerOptions {
	https?: boolean;
}

/**
 * Builds server options object to pass to Fastify when using server factory.
 */
function getServerOptions(is_https: boolean): HttpServerOptions {
	const server_timeout = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_TIMEOUT);
	const keep_alive_timeout = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT);
	return {
		bodyLimit: REQ_MAX_BODY_SIZE,
		connectionTimeout: server_timeout,
		keepAliveTimeout: keep_alive_timeout,
		forceCloseConnections: true,
		return503OnClosing: false,
		// http2: is_https, // for now we are not enabling HTTP/2 since it seems to show slower performance
		https: is_https /* && {
			allowHTTP1: true,
		},*/,
	};
}

/**
 * Builds CORS options object to pass to cors plugin when/if it needs to be registered with Fastify
 */
function getCORSOpts(): FastifyCorsOptions {
	const props_cors = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORS);
	const props_cors_accesslist = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST);
	let cors_options: FastifyCorsOptions;

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
 */
function getHeaderTimeoutConfig(): number {
	return env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_HEADERSTIMEOUT) ?? DEFAULT_HEADERS_TIMEOUT;
}
