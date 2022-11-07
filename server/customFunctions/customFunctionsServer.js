'use strict';

const util = require('util');
const path = require('path');
const fg = require('fast-glob');
const fs = require('fs');

const fastify = require('fastify');
const fastify_cors = require('@fastify/cors');
const fastify_static = require('@fastify/static');
const autoload = require('@fastify/autoload');
const request_time_plugin = require('../serverHelpers/requestTimePlugin');
const env = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
const harper_logger = require('../../utility/logging/harper_logger');
const global_schema = require('../../utility/globalSchema');
const user_schema = require('../../security/user');
const { isMainThread } = require("worker_threads");
const { registerServer } = require('../threads/thread-http-server');
const getServerOptions = require('./helpers/getServerOptions');
const getCORSOptions = require('./helpers/getCORSOptions');
const getHeaderTimeoutConfig = require('./helpers/getHeaderTimeoutConfig');

const p_schema_to_global = util.promisify(global_schema.setSchemaDataToGlobal);

const {
	handleServerUncaughtException,
	serverErrorHandler,
	handleBeforeExit,
	handleExit,
	handleSigint,
	handleSigquit,
	handleSigterm,
} = require('../serverHelpers/serverHandlers');

module.exports = {
	customFunctionsServer,
};
const TRUE_COMPARE_VAL = 'TRUE';
let server = undefined;
let CF_ROUTES_DIR = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);

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

		process.on('uncaughtException', handleServerUncaughtException);
		process.on('beforeExit', handleBeforeExit);
		process.on('exit', handleExit);
		process.on('SIGINT', handleSigint);
		process.on('SIGQUIT', handleSigquit);
		process.on('SIGTERM', handleSigterm);

		await setUp();

		const props_http_secure_on = env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HTTPS);
		const props_server_port = parseInt(env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_PORT), 10);
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
			await server.listen({ port: isMainThread ? props_server_port : 0, host: '::' });
			registerServer(terms.SERVICES.CUSTOM_FUNCTIONS, server.server);
			harper_logger.info(`Custom Functions process running on port ${props_server_port}`);
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
async function buildRoutes(cf_server) {
	try {
		harper_logger.info('Custom Functions starting buildRoutes');

		await cf_server.register(require('./plugins/hdbCore'));
		await cf_server.after();
		const project_folders = fs.readdirSync(CF_ROUTES_DIR, { withFileTypes: true });

		// loop through all the projects
		project_folders.forEach((project_entry) => {
			if (!project_entry.isDirectory() && !project_entry.isSymbolicLink()) return;
			const project_name = project_entry.name;
			const project_folder = path.join(CF_ROUTES_DIR, project_name);
			harper_logger.trace('Loading project folder ' + project_folder);
			const routes_directory = `${project_folder}/routes`;
			const static_directory = `${project_folder}/static`;
			const static_index = `${project_folder}/static/index.html`;
			const static_route = `/${project_name}/static`;

			const set_up_routes = fs.existsSync(routes_directory);
			const set_up_static_route = fs.existsSync(static_directory) && fs.existsSync(static_index);

			// check for a routes folder and, if present, ingest each of the route files in the project's routes folder
			if (set_up_routes) {
				cf_server
					.register(autoload, (parent) => ({
						dir: routes_directory,
						dirNameRoutePrefix: false,
						options: {
							hdbCore: parent.hdbCore,
							logger: harper_logger,
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

			// check for a public folder and, if present, add @fastify/static to the server and set up its route, too
			if (set_up_static_route) {
				harper_logger.info(`Custom Functions setting up webserver for ${project_name}`);
				cf_server
					.register(fastify_static, {
						root: static_directory,
					})
					.after((err, instance, next) => {
						if (err && err.message) {
							harper_logger.error(err.message);
						} else if (err) {
							harper_logger.error(err);
						}
						next();
					});
				cf_server.get(static_route, (req, reply) => reply.sendFile('index.html', static_directory));
			}
		});

		harper_logger.info('Custom Functions completed buildRoutes');
	} catch (e) {
		harper_logger.error(`Custom Functions errored buildRoutes: ${e}`);
	}
}

/**
 * This method configures and returns a Fastify server - for either HTTP or HTTPS  - based on the provided config settings
 *
 * @param is_https - <boolean> - type of communication protocol to build server for
 * @returns {FastifyInstance}
 */
function buildServer(is_https) {
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

		app.register(request_time_plugin);

		// build routes using the file system
		app.register(buildRoutes);

		harper_logger.info(`Custom Functions completed buildServer.`);

		return app;
	} catch (err) {
		harper_logger.error(`Custom Functions process ${process.pid} buildServer error: ${err}`);
		harper_logger.fatal(err);
		process.exit(1);
	}
}
