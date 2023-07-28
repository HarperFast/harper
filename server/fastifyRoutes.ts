import { dirname } from 'path';
import { existsSync } from 'fs';
import fastify from 'fastify';
import fastify_cors from '@fastify/cors';
import request_time_plugin from './serverHelpers/requestTimePlugin';
import autoload from '@fastify/autoload';
import * as env from '../utility/environment/environmentManager';
import { HDB_SETTINGS_NAMES, CONFIG_PARAMS } from '../utility/hdbTerms';
import * as harper_logger from '../utility/logging/harper_logger';
import * as hdbCore from './fastifyRoutes/plugins/hdbCore';
import * as user_schema from '../security/user';
import getServerOptions from './fastifyRoutes/helpers/getServerOptions';
import getCORSOptions from './fastifyRoutes/helpers/getCORSOptions';
import getHeaderTimeoutConfig from './fastifyRoutes/helpers/getHeaderTimeoutConfig';
import { serverErrorHandler } from '../server/serverHelpers/serverHandlers';
import { registerContentHandlers } from '../server/serverHelpers/contentTypes';
import { server } from './Server';

let fastify_server;
const route_folders = new Set();

/**
 * This is the entry point for the fastify route autoloader plugin. This plugin loads JS modules from provided path
 * (configurable) and gives them access to the fastify server, so they can register route handlers. This builds a
 * fastify server instance on-demand, and registers it with the main http access point. Prior to 4.2 this (and static)
 * were basically the only loaders for HarperDB applications, and this supports all legacy custom functions that rely
 * on fastify routes. Fastify's performance is not as good as our native HTTP handling, so generally this isn't the
 * first choice for new applications where performance is a priority, but certainly is a good option for anyone who
 * likes and/or is familiar with fastify and wants to use its plugins.
 * @param js_content
 * @param relative_path
 * @param file_path
 * @param project_name
 */
export async function handleFile(js_content, relative_path, file_path, project_name) {
	if (!fastify_server) {
		const props_http_secure_on = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HTTPS);
		fastify_server = buildServer(props_http_secure_on);
		server.http((await fastify_server).server);
	}
	const resolved_server = await fastify_server;
	const route_folder = dirname(file_path);
	let prefix = relative_path.replace(/\/routes\/.*/g, '');
	if (prefix.startsWith('/')) prefix = prefix.slice(1);
	if (!route_folders.has(route_folder)) {
		route_folders.add(route_folder);
		resolved_server.register(buildRouteFolder(route_folder, prefix));
	}
}
/**
 * Function called to start up server instance on a forked process - this method is called from customFunctionServer after process is
 * forked in the serverParent module
 *
 * @returns {Promise<void>}
 */
export async function customFunctionsServer() {
	try {
		// Instantiate new instance of HDB IPC client and assign it to global.

		harper_logger.info('In Custom Functions Fastify server' + process.cwd());
		harper_logger.info(`Custom Functions Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
		harper_logger.debug(`Custom Functions server process ${process.pid} starting up.`);

		await setUp();

		const props_http_secure_on = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HTTPS);
		const is_https =
			props_http_secure_on &&
			(props_http_secure_on === true || props_http_secure_on.toUpperCase() === TRUE_COMPARE_VAL);
		let server;
		try {
			//generate a Fastify server instance
			server = fastify_server = await buildServer(is_https);
		} catch (err) {
			harper_logger.error(`Custom Functions buildServer error: ${err}`);
			throw err;
		}

		try {
			//make sure the process waits for the server to be fully instantiated before moving forward
			await server.ready();
		} catch (err) {
			harper_logger.error(`Custom Functions server.ready() error: ${err}`);
			throw err;
		}
		// fastify can't clean up properly
		server.server.cantCleanupProperly = true;
	} catch (err) {
		harper_logger.error(`Custom Functions ${process.pid} Error: ${err}`);
		harper_logger.error(err);
		process.exit(1);
	}
}

/**
 * Makes sure global values are set and that clustering connections are set/ready before server starts.
 * @returns {Promise<void>}
 */
async function setUp() {
	try {
		harper_logger.info('Custom Functions starting configuration.');
		await user_schema.setUsersToGlobal();
		harper_logger.info('Custom Functions completed configuration.');
	} catch (e) {
		harper_logger.error(e);
	}
}

// eslint-disable-next-line require-await
function buildRouteFolder(routes_folder, project_name) {
	return async function (cf_server) {
		try {
			harper_logger.info('Custom Functions starting buildRoutes');

			harper_logger.trace('Loading fastify routes folder ' + routes_folder);
			const set_up_routes = existsSync(routes_folder);

			// check for a routes folder and, if present, ingest each of the route files in the project's routes folder
			if (set_up_routes) {
				cf_server
					.register(autoload, (parent) => ({
						dir: routes_folder,
						dirNameRoutePrefix: false,
						options: {
							hdbCore: parent.hdbCore,
							logger: harper_logger.loggerWithTag('custom-function'),
							prefix: `/${project_name}`,
						},
					}))
					.after((err, instance, next) => {
						if (err?.message) {
							harper_logger.error(err.message);
						} else if (err) {
							harper_logger.error(err);
						}
						next();
					});
			}
		} catch (e) {
			harper_logger.error(`Custom Functions errored buildRoutes: ${e}`);
		}
	};
}

/**
 * This method configures and returns a Fastify server - for either HTTP or HTTPS  - based on the provided config settings
 *
 * @param is_https - <boolean> - type of communication protocol to build server for
 * @returns {FastifyInstance}
 */
async function buildServer(is_https) {
	harper_logger.info(`Custom Functions starting buildServer.`);
	const server_opts = getServerOptions(is_https);

	const app = fastify(server_opts);
	//Fastify does not set this property in the initial app construction
	app.server.headersTimeout = getHeaderTimeoutConfig();

	//set top-level error handler for server - all errors caught/thrown within the API will bubble up to this handler so they
	// can be handled in a coordinated way
	app.setErrorHandler(serverErrorHandler);

	const cors_options = getCORSOptions();
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
	await app.register(hdbCore);
	await app.after();
	registerContentHandlers(app);

	harper_logger.info(`Custom Functions completed buildServer.`);
	return app;
}

export function ready() {
	if (fastify_server) {
		if (fastify_server.then) return fastify_server.then((server) => server.ready());
		return fastify_server.ready();
	}
}
