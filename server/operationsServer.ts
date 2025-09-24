import cluster from 'cluster';
import { Resources } from '../resources/Resources.ts';
import env from '../utility/environment/environmentManager.js';
env.initSync();
import * as terms from '../utility/hdbTerms.ts';
import harperLogger from '../utility/logging/harper_logger.js';
import fastify, { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
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

export { operationsServer as hdbServer };
export { operationsServer as start };

/**
 * Builds a HarperDB server.
 */
async function operationsServer(options: ServerOptions & { resources?: Resources }) {
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
		server = buildServer(isHttps, options.resources);

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
	hdbAuthHeader?: unknown;
	bypass_auth?: boolean;
	password?: string;
	payload?: string;
	sql?: string;
	parsedSqlObject?: ParsedSqlObject;
	[key: string]: unknown;
}

type SearchOperation = BaseOperationRequestBody;

interface SearchOperationRequestBody {
	search_operation: SearchOperation;
}

export type OperationRequestBody = BaseOperationRequestBody & Partial<SearchOperationRequestBody>;

export interface OperationRequest {
	body: OperationRequestBody;
}

export interface OperationResult {
	message?: any;
}

/**
 * This method configures and returns a Fastify server - for either HTTP or HTTPS - based on the provided config settings
 */
function buildServer(isHttps: boolean, resources: Resources): FastifyInstance {
	harperLogger.debug(`HarperDB process starting to build ${isHttps ? 'HTTPS' : 'HTTP'} server.`);
	const serverOpts = getServerOptions(isHttps);

	const app = fastify(serverOpts);

	// Fastify does not set this property in the initial app construction
	app.server.headersTimeout = getHeaderTimeoutConfig();

	// Set a top-level error handler for the server - all errors caught/thrown within the API will bubble up to this
	// handler so that they can be handled in a coordinated way
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
	registerContentHandlers(app);

	// Add a simple health check
	app.get('/health', () => 'HarperDB is running.');

	// Add a top-level GET handler for browsers.
	app.register(fastifyStatic, { root: guidePath.join(PACKAGE_ROOT, 'studio/web') });
	const studioOn = env.get(terms.HDB_SETTINGS_NAMES.LOCAL_STUDIO_ON);
	if (!commonUtils.isEmpty(studioOn) && studioOn.toString().toLowerCase() === 'true') {
		app.get('/', (req, res) => res.sendFile('index.html'));
	} else {
		app.get('/', (req, res) => res.sendFile('running.html'));
	}

	// Add the top-level POST handler.
	app.post<{ Body: OperationRequestBody }, { isOperation?: boolean }>(
		'/',
		{
			preValidation: [reqBodyValidationHandler, authHandler],
			config: { isOperation: true },
		},
		handler
	);

	harperLogger.debug(`HarperDB process starting up ${isHttps ? 'HTTPS' : 'HTTP'} server listener.`);

	return app;
}

function handler(req: FastifyRequest<{ Body?: OperationRequestBody }>, reply: FastifyReply) {
	// if the operation is a restart, we have to tell the client not to use keep alive on this connection
	// anymore; it needs to be closed because this thread is going to be terminated
	if (req.body?.operation?.startsWith('restart')) {
		reply.header('Connection', 'close');
	}
	//if no error is thrown below, the response 'data' returned from the handler will be returned with 200/OK code
	return handlePostRequest(req, reply);
}

interface HttpServerOptions extends FastifyServerOptions {
	https?: boolean;
	http2?: boolean;
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
		http2: env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_HTTP2),
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
