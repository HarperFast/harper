"use strict";

const cluster = require('cluster');
const env = require('../utility/environment/environmentManager');
env.initSync();
const terms = require('../utility/hdbTerms');
const hdb_util = require('../utility/common_utils');
const util = require('util');
const harper_logger = require('../utility/logging/harper_logger');

const fs = require('fs');
const fastify = require('fastify');

const pjson = require(`${__dirname}/../package.json`);
const fastify_cors = require('fastify-cors');
const fastify_compress = require('fastify-compress');
const fastify_static = require('fastify-static');
const fastify_helmet = require('fastify-helmet');
const spawn_cluster_connection = require('./socketcluster/connector/spawnSCConnection');
const schema_describe = require('../data_layer/schemaDescribe');
const clean_lmdb = require('../utility/lmdb/cleanLMDBMap');

const signalling = require('../utility/signalling');
const guidePath = require('path');

const global_schema = require('../utility/globalSchema');
const user_schema = require('../security/user');
const job_runner = require('./jobRunner');
const hdb_license = require('../utility/registration/hdb_license');

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
    handleSigterm
} = require('./serverHelpers/serverHandlers');

const REQ_MAX_BODY_SIZE = 1024*1024*1024; //this is 1GB in bytes
const TRUE_COMPARE_VAL = 'TRUE';

const { HDB_SETTINGS_NAMES, HDB_SETTINGS_DEFAULT_VALUES } = terms;
const PROPS_CORS_KEY = HDB_SETTINGS_NAMES.CORS_ENABLED_KEY;
const PROPS_CORS_WHITELIST_KEY = HDB_SETTINGS_NAMES.CORS_WHITELIST_KEY;
const PROPS_SERVER_TIMEOUT_KEY = HDB_SETTINGS_NAMES.SERVER_TIMEOUT_KEY;
const PROPS_SERVER_KEEP_ALIVE_TIMEOUT_KEY = HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY;
const PROPS_HEADER_TIMEOUT_KEY = HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY;
const PROPS_PRIVATE_KEY = HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY;
const PROPS_CERT_KEY = HDB_SETTINGS_NAMES.CERT_KEY;
const PROPS_HTTP_SECURE_ON_KEY = HDB_SETTINGS_NAMES.HTTP_SECURE_ENABLED_KEY;
const PROPS_SERVER_PORT_KEY = HDB_SETTINGS_NAMES.SERVER_PORT_KEY;

const DEFAULT_SERVER_TIMEOUT = HDB_SETTINGS_DEFAULT_VALUES[PROPS_SERVER_TIMEOUT_KEY];
const DEFAULT_KEEP_ALIVE_TIMEOUT = HDB_SETTINGS_DEFAULT_VALUES[PROPS_SERVER_KEEP_ALIVE_TIMEOUT_KEY];
const DEFAULT_HEADER_TIMEOUT = HDB_SETTINGS_DEFAULT_VALUES[PROPS_HEADER_TIMEOUT_KEY];

let hdbServer = undefined;

/**
 * Function called to start up server instance on a forked process - this method is called from hdbServer after process is
 * forked in the serverParent module
 *
 * @returns {Promise<void>}
 */
async function childServer() {
    try {
        harper_logger.info('In Fastify server' + process.cwd());
        harper_logger.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
        harper_logger.debug(`Child server process ${process.pid} starting up.`);

        global.clustering_on = false;
        global.isMaster = cluster.isMaster;

        //this message handler allows all forked processes to communicate with one another0
        process.on('message', handleServerMessage);
        process.on('uncaughtException', handleServerUncaughtException);
        process.on('beforeExit', handleBeforeExit);
        process.on('exit', handleExit);
        process.on('SIGINT', handleSigint);
        process.on('SIGQUIT', handleSigquit);
        process.on('SIGTERM', handleSigterm);

        await setUp();

        const props_http_secure_on = env.get(PROPS_HTTP_SECURE_ON_KEY);
        const props_server_port = env.get(PROPS_SERVER_PORT_KEY);
        const is_https = props_http_secure_on && (props_http_secure_on === true || props_http_secure_on.toUpperCase() === TRUE_COMPARE_VAL);

        //generate a Fastify server instance
        hdbServer = buildServer(is_https);

        //make sure the process waits for the server to be fully instantiated before moving forward
        await hdbServer.ready();

        const server_type = is_https ? 'HTTPS' : 'HTTP';
        try {
            //now that server is fully loaded/ready, start listening on port provided in config settings
            await hdbServer.listen(props_server_port, '::');
            harper_logger.info(`HarperDB ${pjson.version} ${server_type} Server running on port ${props_server_port}`);
            //signal to parent process that server has started on child process
            signalling.signalChildStarted();
        } catch(err) {
            hdbServer.close();
            harper_logger.error(`Error configuring ${server_type} server`);
            throw err;
        }
    } catch(err) {
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
        harper_logger.trace('Configuring child process.');
        await p_schema_to_global();
        await user_schema.setUsersToGlobal();
        spawn_cluster_connection(true);
        await hdb_license.getLicense();
    } catch(e) {
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
    harper_logger.debug(`Child process starting to build ${is_https ? 'HTTPS' : 'HTTP'} server.`);
    let server_opts = getServerOptions(is_https);
    const app = fastify(server_opts);
    //Fastify does not set this property in the initial app construction
    app.server.headersTimeout = getHeaderTimeoutConfig();

    //set top-level error handler for server - all errors caught/thrown within the API will bubble up to this handler so they
    // can be handled in a coordinated way
    app.setErrorHandler(serverErrorHandler);

    const cors_options = getCORSOpts();
    if (cors_options) {
        app.register(fastify_cors, cors_options);
    }

    //Register security headers for Fastify instance - https://helmetjs.github.io/
    app.register(fastify_helmet);

    // This handles all get requests for the studio
    app.register(fastify_compress);
    app.register(fastify_static, {root: guidePath.join(__dirname,'../docs')});
    app.get('/', function(req, res) {
        return res.sendFile('index.html');
    });

    // This handles all POST requests
    app.post('/', {
            preValidation: [reqBodyValidationHandler, authHandler]
        },
        async function (req, res) {
            //if no error is thrown below, the response 'data' returned from the handler will be returned with 200/OK code
            return handlePostRequest(req);
        }
    );

    harper_logger.debug(`Child process starting up ${is_https ? 'HTTPS' : 'HTTP'} server listener.`);

    return app;
}

/**
 * Builds server options object to pass to Fastify when using server factory.
 *
 * @param is_https
 * @returns {{keepAliveTimeout: *, bodyLimit: number, connectionTimeout: *}}
 */
function getServerOptions(is_https) {
    const server_timeout = env.get(PROPS_SERVER_TIMEOUT_KEY) ? env.get(PROPS_SERVER_TIMEOUT_KEY) : DEFAULT_SERVER_TIMEOUT;
    const keep_alive_timeout = env.get(PROPS_SERVER_KEEP_ALIVE_TIMEOUT_KEY) ?
        env.get(PROPS_SERVER_KEEP_ALIVE_TIMEOUT_KEY) : DEFAULT_KEEP_ALIVE_TIMEOUT;

    const server_opts = {
        bodyLimit: REQ_MAX_BODY_SIZE,
        connectionTimeout: server_timeout,
        keepAliveTimeout: keep_alive_timeout
    };

    if (is_https) {
        const privateKey = env.get(PROPS_PRIVATE_KEY);
        const certificate = env.get(PROPS_CERT_KEY);
        const credentials = {key: fs.readFileSync(`${privateKey}`), cert: fs.readFileSync(`${certificate}`)};
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
    let props_cors_whitelist = env.get(PROPS_CORS_WHITELIST_KEY);
    let cors_options;

    if (props_cors && (props_cors === true || props_cors.toUpperCase() === TRUE_COMPARE_VAL)) {
        cors_options = {
            origin: true,
            allowedHeaders: ['Content-Type', 'Authorization'],
            credentials: false
        };
        if (props_cors_whitelist && props_cors_whitelist.length > 0) {
            let whitelist = props_cors_whitelist.split(',');
            cors_options.origin = (origin, callback) => {
                if (whitelist.indexOf(origin) !== -1) {
                    return callback(null, true);
                }
                return callback(new Error(`domain ${origin} is not whitelisted`));
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
    return env.get(PROPS_HEADER_TIMEOUT_KEY) ? env.get(PROPS_HEADER_TIMEOUT_KEY) : DEFAULT_HEADER_TIMEOUT;
}

/**
 * Switch statement for handling messages from other forked processes
 *
 * @param msg - msg object passed from another forked process
 * @returns {Promise<void>}
 */
async function handleServerMessage(msg) {
    switch (msg.type) {
        case 'schema':
            clean_lmdb(msg);
            await syncSchemaMetadata(msg);
            break;
        case 'user':
            try {
                await user_schema.setUsersToGlobal();
            } catch(e){
                harper_logger.error(e);
            }
            break;
        case 'job':
            job_runner.parseMessage(msg.runner_message).then((result) => {
                harper_logger.info(`completed job with result: ${JSON.stringify(result)}`);
            }).catch(function isError(e) {
                harper_logger.error(e);
            });
            break;
        case terms.CLUSTER_MESSAGE_TYPE_ENUM.RESTART:
            harper_logger.info(`Server close event received for process ${process.pid}`);
            harper_logger.debug(`calling shutdown`);
            await shutDown().then(() => {
                harper_logger.info(`Completed shut down`);
                process.exit(terms.RESTART_CODE_NUM);
            });
            break;
        default:
            harper_logger.info(`Received unknown signaling message ${msg.type}, ignoring message`);
            break;
    }
}

/**
 * Switch statement to handle schema-related messages from other forked processes - i.e. if another process completes an
 * operation that updates schema and, therefore, requires that we update the global schema value for the process
 *
 * @param msg
 * @returns {Promise<void>}
 */
async function syncSchemaMetadata(msg) {
    try{
        if (global.hdb_schema !== undefined && typeof global.hdb_schema === 'object' && msg.operation !== undefined) {

            switch (msg.operation.operation) {
                case 'drop_schema':
                    delete global.hdb_schema[msg.operation.schema];
                    break;
                case 'drop_table':
                    if (global.hdb_schema[msg.operation.schema] !== undefined) {
                        delete global.hdb_schema[msg.operation.schema][msg.operation.table];
                    }
                    break;
                case 'create_schema':
                    if (global.hdb_schema[msg.operation.schema] === undefined) {
                        global.hdb_schema[msg.operation.schema] = {};
                    }
                    break;
                case 'create_table':
                case 'create_attribute':
                    if (global.hdb_schema[msg.operation.schema] === undefined) {
                        global.hdb_schema[msg.operation.schema] = {};
                    }

                    global.hdb_schema[msg.operation.schema][msg.operation.table] =
                        await schema_describe.describeTable({schema: msg.operation.schema, table: msg.operation.table});
                    break;
                default:
                    global_schema.setSchemaDataToGlobal(handleErrorCallback);
                    break;
            }
        } else{
            global_schema.setSchemaDataToGlobal(handleErrorCallback);
        }
    } catch(e) {
        harper_logger.error(e);
    }
}

function handleErrorCallback(err) {
    if (err) {
        harper_logger.error(err);
    }
}

/**
 * This method is used for soft/graceful server shutdowns - i.e. when we want to allow existing API requests/operations to
 * complete/be returned before exiting the process and restarting the server.
 *
 * @returns {Promise<void>}
 */
async function shutDown() {
    harper_logger.debug(`Calling shutdown`);
    if (hdbServer) {
        setTimeout(() => {
            harper_logger.info(`Timeout occurred during client disconnect.  Took longer than ${terms.RESTART_TIMEOUT_MS}ms.`);
            signalling.signalChildStopped();
        }, terms.RESTART_TIMEOUT_MS);

        try {
            await hdbServer.close();
            hdbServer = null;
            harper_logger.debug(`Process pid:${process.pid} - server closed`);
        } catch (err) {
            harper_logger.debug(`Process pid:${process.pid} - error closing server - ${err}`);
        }
    }
    harper_logger.info(`Process pid:${process.pid} - Work completed, shutting down`);
    signalling.signalChildStopped();
}

module.exports = childServer;

