import util from 'util';
import { join, dirname } from 'path';
import fs from 'fs';

import fastify from 'fastify';
import fastify_cors from '@fastify/cors';
import autoload from '@fastify/autoload';
import * as env from '../utility/environment/environmentManager';
import { HDB_SETTINGS_NAMES, CONFIG_PARAMS } from '../utility/hdbTerms';
import * as harper_logger from '../utility/logging/harper_logger';
import * as hdbCore from '../server/customFunctions/plugins/hdbCore';
import * as user_schema from '../security/user';
import { isMainThread } from 'worker_threads';
import * as getServerOptions from '../server/customFunctions/helpers/getServerOptions';
import * as getCORSOptions from '../server/customFunctions/helpers/getCORSOptions';
import * as getHeaderTimeoutConfig from '../server/customFunctions/helpers/getHeaderTimeoutConfig';

import { serverErrorHandler } from '../server/serverHelpers/serverHandlers';
import { registerContentHandlers } from '../server/serverHelpers/contentTypes';
import { plugins } from '../index';
let CF_ROUTES_DIR = env.get(HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);

let fastify_server;
let route_folders = new Set();
export async function handleFile(js_content, relative_path, file_path, project_name) {
	if (!fastify_server) {
		const props_http_secure_on = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HTTPS);
		fastify_server = buildServer(props_http_secure_on);
		plugins.customFunctionHandler((await fastify_server).server);
	}
	let server = await fastify_server;
	let route_folder = dirname(file_path);
	if (!route_folders.has(route_folder)) {
		route_folders.add(route_folder);
		server.register(buildRouteFolder(route_folder, project_name));
	}
}
/**
 * Function called to start up server instance on a forked process - this method is called from customFunctionServer after process is
 * forked in the serverParent module
 *
 * @returns {Promise<void>}
 */
async function customFunctionsServer() {
	try {
		// Instantiate new instance of HDB IPC client and assign it to global.

		harper_logger.info('In Custom Functions Fastify server' + process.cwd());
		harper_logger.info(`Custom Functions Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
		harper_logger.debug(`Custom Functions server process ${process.pid} starting up.`);

		await setUp();

		const props_http_secure_on = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HTTPS);
		const props_server_port = parseInt(env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_PORT), 10);
		const is_https =
			props_http_secure_on &&
			(props_http_secure_on === true || props_http_secure_on.toUpperCase() === TRUE_COMPARE_VAL);

		try {
			//generate a Fastify server instance
			server = buildServer(is_https);
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

		try {
			//now that server is fully loaded/ready, start listening on port provided in config settings
			harper_logger.info(`Custom Functions process starting on port ${props_server_port}`);
			registerServer(props_server_port, server.server);
			if (isMainThread) {
				await server.listen({ port: props_server_port, host: '::' });
				harper_logger.info(`Custom Functions process running on port ${props_server_port}`);
			} else if (!server.server.closeIdleConnections) {
				// before Node v18, closeIdleConnections is not available, and we have to setup a listener for fastify
				// to handle closing by setting up the dynamic port
				await server.listen({ port: 0, host: '::' });
			}
		} catch (err) {
			server.close();
			harper_logger.error(`Custom Functions server.listen() error: ${err}`);
			throw err;
		}
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
		await p_schema_to_global();
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
			const set_up_routes = fs.existsSync(routes_folder);

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
						if (err && err.message) {
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
	try {
		harper_logger.info(`Custom Functions starting buildServer.`);
		let server_opts = getServerOptions(is_https);

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

		await app.register(hdbCore);
		await app.after();
		registerContentHandlers(app);

		harper_logger.info(`Custom Functions completed buildServer.`);
		return app;
	} catch (err) {
		harper_logger.error(`Custom Functions process ${process.pid} buildServer error: ${err}`);
		harper_logger.fatal(err);
		process.exit(1);
	}
}

export function ready() {
	if (fastify_server) {
		if (fastify_server.then) return fastify_server.then((server) => server.ready());
		return fastify_server.ready();
	}
}
