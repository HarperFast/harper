"use strict";

const util = require('util');
const path = require('path');
const fs = require('fs');

const fastify = require('fastify');
const fastify_cors = require('fastify-cors');
const fastify_helmet = require('fastify-helmet');
const autoload = require('fastify-autoload');

const spawn_cluster_connection = require('../socketcluster/connector/spawnSCConnection');
const env = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
const harper_logger = require('../../utility/logging/harper_logger');
const signalling = require('../../utility/signalling');
const global_schema = require('../../utility/globalSchema');
const user_schema = require('../../security/user');
const IPCClient = require('../ipc/IPCClient');
const { ChildStartedMsg, ChildStoppedMsg, validateEvent } = require('../ipc/utility/ipcUtils');
let hdb_child_ipc_handlers = require('../ipc/hdbChildIpcHandlers');

const getServerOptions = require('./helpers/getServerOptions');
const getCORSOptions = require('./helpers/getCORSOptions');
const getHeaderTimeoutConfig = require('./helpers/getHeaderTimeoutConfig');

const p_schema_to_global = util.promisify(global_schema.setSchemaDataToGlobal);

const { handleServerUncaughtException, serverErrorHandler } = require('../serverHelpers/serverHandlers.js');

const TRUE_COMPARE_VAL = 'TRUE';
let customFunctionsServer = undefined;
let endpoint_base = env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_DIRECTORY_KEY);

/**
 * Function called to start up server instance on a forked process - this method is called from customFunctionServer after process is
 * forked in the serverParent module
 *
 * @returns {Promise<void>}
 */
async function childServer() {
    try {
        // Instantiate new instance of HDB IPC client and assign it to global.
        try {
            // The restart event handler needs to be assigned here because it requires the customFunctionsServer value.
            hdb_child_ipc_handlers[terms.IPC_EVENT_TYPES.RESTART] = shutDown;
            global.hdb_ipc = new IPCClient(process.pid, hdb_child_ipc_handlers);
        } catch(err) {
            harper_logger.error('Error instantiating new instance of IPC client in Custom Functions server child');
            harper_logger.error(err);
            throw err;
        }

        harper_logger.info('In Custom Functions Fastify server' + process.cwd());
        harper_logger.info(`Custom Functions Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
        harper_logger.debug(`Custom Functions Child server process ${process.pid} starting up.`);
        process.on('uncaughtException', handleServerUncaughtException);

        await setUp();

        const props_http_secure_on = env.getProperty(terms.HDB_SETTINGS_NAMES.HTTP_SECURE_ENABLED_KEY);
        const props_server_port = parseInt(env.getProperty(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_PORT_KEY), 10);
        const is_https = props_http_secure_on && (props_http_secure_on === true || props_http_secure_on.toUpperCase() === TRUE_COMPARE_VAL);

        try {
            //generate a Fastify server instance
            customFunctionsServer = buildServer(is_https);
        } catch(err) {
            harper_logger.error(`Custom Functions childServer.buildServer() error: ${err}`);
            throw err;
        }

        try {
            //make sure the process waits for the server to be fully instantiated before moving forward
            await customFunctionsServer.ready();
        } catch(err) {
            harper_logger.error(`Custom Functions childServer.ready() error: ${err}`);
            throw err;
        }

        try {
            //now that server is fully loaded/ready, start listening on port provided in config settings
            harper_logger.info(`Custom Functions child process starting on port ${props_server_port}`);
            await customFunctionsServer.listen(props_server_port, '::');
            harper_logger.info(`Custom Functions child process running on port ${props_server_port}`);
            //signal to parent process that server has started on child process
            signalling.signalChildStarted(new ChildStartedMsg(process.pid, terms.SERVICES.CUSTOM_FUNCTIONS));
        } catch(err) {
            customFunctionsServer.close();
            harper_logger.error(`Custom Functions childServer.listen() error: ${err}`);
            throw err;
        }
    } catch(err) {
        harper_logger.error(`Custom Functions ${process.pid} Error: ${err}`);
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
        harper_logger.info('Custom Functions starting configuration.');
        await p_schema_to_global();
        await user_schema.setUsersToGlobal();
        //Functions should not be receiving messages from the clustering server, in order to only push we pass false for the is_worker argument
        spawn_cluster_connection(false);

        harper_logger.info('Custom Functions completed configuration.');
    } catch(e) {
        harper_logger.error(e);
    }
}

async function buildRoutes (server) {
    try {
        harper_logger.info('Custom Functions starting createServer');

        const routesDir = `${endpoint_base}/routes`;
        const helpersDir = `${endpoint_base}/helpers`;

        if (!fs.existsSync(routesDir)){
            fs.mkdirSync(routesDir, { recursive: true });
        }
        if (!fs.existsSync(helpersDir)){
            fs.mkdirSync(helpersDir, { recursive: true });
        }

        server.register(autoload, {
            dir: path.join(__dirname, 'plugins')
        });

        server.register(autoload, parent => ({
            dir: `${endpoint_base}/routes`,
            options: {
                hdbCore: parent.hdbCore,
                logger: harper_logger,
            }
        }));

        harper_logger.info('Custom Functions completed createServer');
    } catch (e) {
        harper_logger.error(`Custom Functions errored createServer: ${e}`);
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

        //Register security headers for Fastify instance - https://helmetjs.github.io/
        app.register(fastify_helmet);

        // build routes using the file system
        app.register(buildRoutes);

        harper_logger.info(`Custom Functions completed buildServer.`);

        return app;
    } catch (err) {
        harper_logger.error(`Custom Functions child process ${process.pid} buildServer error: ${err}`);
        harper_logger.fatal(err);
        process.exit(1);
    }
}

/**
 * This method is used for soft/graceful server shutdowns - i.e. when we want to allow existing API requests/operations to
 * complete/be returned before exiting the process and restarting the server.
 *
 * @returns {Promise<void>}
 */
async function shutDown(event) {
    const validate = validateEvent(event);
    if (validate) {
        harper_logger.error(validate);
        return;
    }

    if (event.message.force !== true) {
        harper_logger.info(`Server close event received for process ${process.pid}`);
        harper_logger.debug(`Calling shutdown`);
        if (customFunctionsServer) {
            setTimeout(() => {
                harper_logger.info(`Timeout occurred during client disconnect.  Took longer than ${terms.RESTART_TIMEOUT_MS}ms.`);
                signalling.signalChildStopped(new ChildStoppedMsg(process.pid, terms.SERVICES.CUSTOM_FUNCTIONS));
            }, terms.RESTART_TIMEOUT_MS);

            try {
                await customFunctionsServer.close();
                customFunctionsServer = null;
                harper_logger.debug(`Process pid:${process.pid} - server closed`);
            } catch (err) {
                harper_logger.debug(`Process pid:${process.pid} - error closing server - ${err}`);
            }
        }
        harper_logger.info(`Process pid:${process.pid} - Work completed, shutting down`);
        signalling.signalChildStopped(new ChildStoppedMsg(process.pid, terms.SERVICES.CUSTOM_FUNCTIONS));
    }
}

module.exports = childServer;
