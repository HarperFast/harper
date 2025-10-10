import { dirname } from 'path';
import { existsSync } from 'fs';
import fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import requestTimePlugin from './serverHelpers/requestTimePlugin.js';
import autoload from '@fastify/autoload';
import * as env from '../utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import * as harperLogger from '../utility/logging/harper_logger.js';
import * as hdbCore from './fastifyRoutes/plugins/hdbCore.js';
import * as userSchema from '../security/user.js';
import getServerOptions from './fastifyRoutes/helpers/getServerOptions.js';
import getCORSOptions from './fastifyRoutes/helpers/getCORSOptions.js';
import getHeaderTimeoutConfig from './fastifyRoutes/helpers/getHeaderTimeoutConfig.js';
import { serverErrorHandler } from '../server/serverHelpers/serverHandlers.js';
import { registerContentHandlers } from '../server/serverHelpers/contentTypes.ts';
import { server } from './Server.ts';

let fastifyServer;
const routeFolders = new Set();

/**
 * This is the entry point for the fastify route autoloader plugin. This plugin loads JS modules from provided path
 * (configurable) and gives them access to the fastify server, so they can register route handlers. This builds a
 * fastify server instance on-demand, and registers it with the main http access point. Prior to 4.2 this (and static)
 * were basically the only loaders for HarperDB applications, and this supports all legacy custom functions that rely
 * on fastify routes. Fastify's performance is not as good as our native HTTP handling, so generally this isn't the
 * first choice for new applications where performance is a priority, but certainly is a good option for anyone who
 * likes and/or is familiar with fastify and wants to use its plugins.
 * @param jsContent
 * @param relativePath
 * @param filePath
 * @param projectName
 */
export function start(options) {
	// if we have a secure port, need to use the secure HTTP server for fastify (it can be used for HTTP as well)
	const isHttps = options.securePort > 0;
	return {
		async handleFile(jsContent, relativePath, filePath, projectName) {
			if (!fastifyServer) {
				fastifyServer = buildServer(isHttps);
				server.http((await fastifyServer).server);
			}
			const resolvedServer = await fastifyServer;
			const routeFolder = dirname(filePath);
			let prefix = dirname(relativePath);
			if (prefix.startsWith('/')) prefix = prefix.slice(1);
			if (!routeFolders.has(routeFolder)) {
				routeFolders.add(routeFolder);
				try {
					resolvedServer.register(buildRouteFolder(routeFolder, prefix));
				} catch (error) {
					if (error.message === 'Root plugin has already booted')
						harperLogger.warn(
							`Could not load root fastify route for ${filePath}, this may require a restart to install properly`
						);
					else throw error;
				}
			}
		},
		ready,
	};
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

		harperLogger.info('In Custom Functions Fastify server' + process.cwd());
		harperLogger.info(`Custom Functions Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
		harperLogger.debug(`Custom Functions server process ${process.pid} starting up.`);

		await setUp();

		const isHttps = env.get(CONFIG_PARAMS.HTTP_SECUREPORT) > 0;
		let server;
		try {
			//generate a Fastify server instance
			server = fastifyServer = await buildServer(isHttps);
		} catch (err) {
			harperLogger.error(`Custom Functions buildServer error: ${err}`);
			throw err;
		}

		try {
			//make sure the process waits for the server to be fully instantiated before moving forward
			await server.ready();
		} catch (err) {
			harperLogger.error(`Custom Functions server.ready() error: ${err}`);
			throw err;
		}
		// fastify can't clean up properly
		server.server.cantCleanupProperly = true;
	} catch (err) {
		harperLogger.error(`Custom Functions ${process.pid} Error: ${err}`);
		harperLogger.error(err);
		process.exit(1);
	}
}

/**
 * Makes sure global values are set before server starts.
 * @returns {Promise<void>}
 */
async function setUp() {
	try {
		harperLogger.info('Custom Functions starting configuration.');
		await userSchema.setUsersWithRolesCache();
		harperLogger.info('Custom Functions completed configuration.');
	} catch (e) {
		harperLogger.error(e);
	}
}

// eslint-disable-next-line require-await
function buildRouteFolder(routesFolder, projectName) {
	return async function (cfServer) {
		try {
			harperLogger.info('Custom Functions starting buildRoutes');

			harperLogger.trace('Loading fastify routes folder ' + routesFolder);
			const setUpRoutes = existsSync(routesFolder);

			// check for a routes folder and, if present, ingest each of the route files in the project's routes folder
			if (setUpRoutes) {
				cfServer
					.register(autoload, (parent) => ({
						dir: routesFolder,
						dirNameRoutePrefix: false,
						options: {
							hdbCore: parent.hdbCore,
							logger: harperLogger.loggerWithTag('custom-function'),
							prefix: `/${projectName}`,
						},
					}))
					.after((err, instance, next) => {
						if (err?.message) {
							harperLogger.error(err.message);
						} else if (err) {
							harperLogger.error(err);
						}
						next();
					});
			}
		} catch (e) {
			harperLogger.error(`Custom Functions errored buildRoutes: ${e}`);
		}
	};
}

/**
 * This method configures and returns a Fastify server - for either HTTP or HTTPS  - based on the provided config settings
 *
 * @param isHttps - <boolean> - type of communication protocol to build server for
 * @returns {FastifyInstance}
 */
async function buildServer(isHttps) {
	harperLogger.info(`Custom Functions starting buildServer.`);
	const serverOpts = getServerOptions(isHttps);

	const app = fastify(serverOpts);
	//Fastify does not set this property in the initial app construction
	app.server.headersTimeout = getHeaderTimeoutConfig();

	//set top-level error handler for server - all errors caught/thrown within the API will bubble up to this handler so they
	// can be handled in a coordinated way
	app.setErrorHandler(serverErrorHandler);

	const corsOptions = getCORSOptions();
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
	await app.register(hdbCore);
	await app.after();
	registerContentHandlers(app);

	harperLogger.info(`Custom Functions completed buildServer.`);
	return app;
}

export function ready() {
	if (fastifyServer) {
		if (fastifyServer.then)
			return fastifyServer.then((server) => {
				return server.ready();
			});
		return fastifyServer.ready();
	}
}
