import cluster from 'cluster';
import env from '../utility/environment/environmentManager.js';
env.initSync();
import * as terms from '../utility/hdbTerms.ts';
import harperLogger from '../utility/logging/harper_logger.js';
import fastify, { FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyCors, { type FastifyCorsOptions } from '@fastify/cors';
import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import requestTimePlugin from './serverHelpers/requestTimePlugin.js';
import guidePath from 'path';
import { PACKAGE_ROOT } from '../utility/packageUtils.js';
import globalSchema from '../utility/globalSchema.js';
import commonUtils from '../utility/common_utils.js';
import userSchema from '../security/user.js';
import { server as serverRegistration, type ServerOptions } from '../server/Server.ts';
import {
	authHandler,
	handlePostRequest,
	serverErrorHandler,
	reqBodyValidationHandler,
} from './serverHelpers/serverHandlers.js';
import { registerContentHandlers } from './serverHelpers/contentTypes.ts';
import type { OperationFunctionName } from './serverHelpers/serverUtilities.ts';
import type { ParsedSqlObject } from '../sqlTranslator/index.js';
import type { User } from '../resources/ResourceInterface.ts';

const DEFAULT_HEADERS_TIMEOUT = 60000;
const REQ_MAX_BODY_SIZE = 1024 * 1024 * 1024; //this is 1GB in bytes
const TRUE_COMPARE_VAL = 'TRUE';

const { CONFIG_PARAMS } = terms;
let server;

export {operationsServer as hdbServer};
export {operationsServer as start};

/**
 * Builds a HarperDB server.
 */
async function operationsServer(options: ServerOptions) {
	try {
		harperLogger.debug('In Fastify server' + process.cwd());
		harperLogger.debug(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
		harperLogger.debug(`HarperDB server process ${process.pid} starting up.`);

		global.clustering_on = false;
		global.isMaster = cluster.isMaster;

		await setUp();
		// if we have a secure port, need to use the secure HTTP server for fastify (it can be used for HTTP as well)
		const isHttps = options.securePort > 0;

		//generate a Fastify server instance
		server = buildServer(isHttps);

		//make sure the process waits for the server to be fully instantiated before moving forward
		await server.ready();
		if (!options) options = {};
		options.isOperationsServer = true;
		// fastify can't clean up properly
		try {
			// now that server is fully loaded/ready, start listening on port provided in config settings or just use
			// zero to wait for sockets from the main thread
			serverRegistration.http(server.server, options);
			if (!server.server.closeIdleConnections) {
				// before Node v18, closeIdleConnections is not available, and we have to setup a listener for fastify
				// to handle closing by setting up the dynamic port
				await server.listen({ port: 0, host: '::' });
			}
		} catch (err) {
			server.close();
			harperLogger.error(err);
			harperLogger.error(`Error configuring operations server`);
			throw err;
		}
	} catch (err) {
		console.error(`Failed to build server on ${process.pid}`, err);
		harperLogger.fatal(err);
		process.exit(1);
	}
}

/**
 * Makes sure global values are set and that clustering connections are set/ready before server starts.
 */
async function setUp() {
	harperLogger.trace('Configuring HarperDB process.');
	globalSchema.setSchemaDataToGlobal();
	return userSchema.setUsersWithRolesCache();
}

interface BaseOperationRequestBody {
	operation: OperationFunctionName;
	bypassAuth: boolean;
	hdb_user?: User;
	password?: string;
	payload?: string;
	sql?: string;
	parsedSqlObject?: ParsedSqlObject;
}

type SearchOperation = BaseOperationRequestBody;

interface SearchOperationRequestBody {
	searchOperation: SearchOperation;
}

export type OperationRequestBody = BaseOperationRequestBody & SearchOperationRequestBody;

export interface OperationRequest {
	body: OperationRequestBody;
}

export interface OperationResult {
	message?: any;
}

/**
 * This method configures and returns a Fastify server - for either HTTP or HTTPS  - based on the provided config settings
 */
function buildServer(isHttps: boolean): FastifyInstance {
	harperLogger.debug(`HarperDB process starting to build ${isHttps ? 'HTTPS' : 'HTTP'} server.`);
	const serverOpts = getServerOptions(isHttps);
	/*
	TODO: Eventually we may want to directly forward requests to fastify rather than having it create a
	(pseudo) server.
	let requestHandler;
	serverOpts.serverFactory = (handler) => {
		requestHandler = (request) => {
			return handler(request[nodeRequestKey], request[nodeResponseKey]);
		};
		return { on() {} };
	};*/
	const app = fastify(serverOpts);

	//Fastify does not set this property in the initial app construction
	app.server.headersTimeout = getHeaderTimeoutConfig();

	// set top-level error handler for server - all errors caught/thrown within the API will bubble up to this
	// handler so they can be handled in a coordinated way
	app.setErrorHandler(serverErrorHandler);

	const corsOptions = getCORSOpts();
	if (corsOptions) {
		app.register(fastifyCors, corsOptions);
	}

	app.register(function (instance, options, done) {
		instance.setNotFoundHandler(function (request, reply) {
			app.server.emit('unhandled', request.raw, reply.raw);
		});
		done();
	});

	app.register(requestTimePlugin);

	// This handles all get requests for the studio
	app.register(fastifyCompress);
	app.register(fastifyStatic, { root: guidePath.join(PACKAGE_ROOT, 'studio/web') });
	registerContentHandlers(app);

	const studioOn = env.get(terms.HDB_SETTINGS_NAMES.LOCAL_STUDIO_ON);
	app.get('/', function (req, res) {
		//if the local studio is enabled we will serve it, otherwise return 404
		if (!commonUtils.isEmpty(studioOn) && studioOn.toString().toLowerCase() === 'true') {
			return res.sendFile('index.html');
		}
		return res.sendFile('running.html');
	});

	// This handles all POST requests
	app.post<{ Body: OperationRequestBody }>(
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

	harperLogger.debug(`HarperDB process starting up ${isHttps ? 'HTTPS' : 'HTTP'} server listener.`);

	return app;
}

interface HttpServerOptions extends FastifyServerOptions {
	https?: boolean;
}

/**
 * Builds server options object to pass to Fastify when using server factory.
 */
function getServerOptions(isHttps: boolean): HttpServerOptions {
	const server_timeout = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_TIMEOUT);
	const keep_alive_timeout = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_KEEPALIVETIMEOUT);
	return {
		bodyLimit: REQ_MAX_BODY_SIZE,
		connectionTimeout: server_timeout,
		keepAliveTimeout: keep_alive_timeout,
		forceCloseConnections: true,
		return503OnClosing: false,
		// http2: isHttps, // for now we are not enabling HTTP/2 since it seems to show slower performance
		https: isHttps /* && {
			allowHTTP1: true,
		},*/,
	};
}

/**
 * Builds CORS options object to pass to cors plugin when/if it needs to be registered with Fastify
 */
function getCORSOpts(): FastifyCorsOptions {
	const propsCors = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORS);
	const propsCorsAccesslist = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST);
	let corsOptions: FastifyCorsOptions;

	if (propsCors && (propsCors === true || propsCors.toUpperCase() === TRUE_COMPARE_VAL)) {
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

/**
 * Returns header timeout value from config file or, if not entered, the default value
 */
function getHeaderTimeoutConfig(): number {
	return env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_HEADERSTIMEOUT) ?? DEFAULT_HEADERS_TIMEOUT;
}
