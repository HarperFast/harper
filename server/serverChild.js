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
    reqBodyValidationHandler
} = require('./serverHelpers/serverHandlers.js');

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

async function childServer() {
    try {
        harper_logger.info('In Fastify server' + process.cwd());
        harper_logger.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
        harper_logger.debug(`Child server process ${process.pid} starting up.`);

        global.clustering_on = false;
        global.isMaster = cluster.isMaster;

        process.on('message', handleServerMessage);
        process.on('uncaughtException', handleServerUncaughtException);

        await setUp();

        const props_http_secure_on = env.get(PROPS_HTTP_SECURE_ON_KEY);
        const props_server_port = env.get(PROPS_SERVER_PORT_KEY);
        const is_https = props_http_secure_on && (props_http_secure_on === true || props_http_secure_on.toUpperCase() === TRUE_COMPARE_VAL);

        hdbServer = buildServer(is_https);

        await hdbServer.ready();

        const server_type = is_https ? 'HTTPS' : 'HTTP';
        try {
            await hdbServer.listen(props_server_port, '::');
            harper_logger.info(`HarperDB ${pjson.version} ${server_type} Server running on port ${props_server_port}`);
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

function buildServer(is_https) {
    harper_logger.debug(`Child process starting to build ${is_https ? 'HTTPS' : 'HTTP'} server.`);
    let server_opts = getServerOptions(is_https);
    const app = fastify(server_opts);
    //Fastify does not set this property in the initial app construction
    app.server.headersTimeout = getHeaderTimeoutConfig();

    //set top-level error handler for server
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
            return await handlePostRequest(req);
        }
    );

    harper_logger.debug(`Child process starting up ${is_https ? 'HTTPS' : 'HTTP'} server listener.`);

    return app;
}

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

function getHeaderTimeoutConfig() {
    return env.get(PROPS_HEADER_TIMEOUT_KEY) ? env.get(PROPS_HEADER_TIMEOUT_KEY) : DEFAULT_HEADER_TIMEOUT;
}

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
                    global_schema.schemaSignal(err => {
                        if (err) {
                            harper_logger.error(err);
                        }
                    });
                    break;
            }
        } else{
            global_schema.schemaSignal(err => {
                if (err) {
                    harper_logger.error(err);
                }
            });
        }
    } catch(e) {
        harper_logger.error(e);
    }
}

async function shutDown() {
    harper_logger.debug(`Calling shutdown`);
    if (hdbServer) {
        setTimeout(() => {
            harper_logger.info(`Timeout occurred during client disconnect.  Took longer than ${terms.RESTART_TIMEOUT_MS}ms.`);
            hdb_util.callProcessSend({type: terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STOPPED, pid: process.pid});
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
    hdb_util.callProcessSend({type: terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STOPPED, pid: process.pid});
}

module.exports = childServer;

