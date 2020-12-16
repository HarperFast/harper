"use strict";

const cluster = require('cluster');
const env = require('../utility/environment/environmentManager');
env.initSync();
const terms = require('../utility/hdbTerms');
const hdb_util = require('../utility/common_utils');
const os = require('os');
const util = require('util');

const harper_logger = require('../utility/logging/harper_logger');
const fs = require('fs');
const fastify = require('fastify');
const auth = require('../security/auth');
const p_authorize = util.promisify(auth.authorize);

const pjson = require(`${__dirname}/../package.json`);
const server_utilities = require('./serverUtilities');
const p_choose_operation = util.promisify(server_utilities.chooseOperation);
const fastify_cors = require('fastify-cors');
const fastify_compress = require('fastify-compress');
const fastify_static = require('fastify-static');
const fastify_helmet = require('fastify-helmet');
const spawn_cluster_connection = require('./socketcluster/connector/spawnSCConnection');
const schema_describe = require('../data_layer/schemaDescribe');
const clean_lmdb = require('../utility/lmdb/cleanLMDBMap');

const signalling = require('../utility/signalling');
const guidePath = require('path');
const hdb_errors = require('../utility/errors/commonErrors');
const PermissionResponseObject = require('../security/data_objects/PermissionResponseObject');
const global_schema = require('../utility/globalSchema');
const user_schema = require('../security/user');
const job_runner = require('./jobRunner');
const hdb_license = require('../utility/registration/hdb_license');

const p_schema_to_global = util.promisify(global_schema.setSchemaDataToGlobal);

const REQ_MAX_BODY_SIZE = 1024*1024*1024; //this is 1GB in bytes
const TRUE_COMPARE_VAL = 'TRUE';

const { HDB_SETTINGS_NAMES, HDB_SETTINGS_DEFAULT_VALUES } = terms;
const PROPS_CORS_KEY = HDB_SETTINGS_NAMES.CORS_ENABLED_KEY;
const PROPS_CORS_WHITELIST_KEY = HDB_SETTINGS_NAMES.CORS_WHITELIST_KEY;
const PROPS_SERVER_TIMEOUT_KEY = HDB_SETTINGS_NAMES.PROPS_SERVER_TIMEOUT_KEY;
const PROPS_SERVER_KEEP_ALIVE_TIMEOUT_KEY = HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY;
const PROPS_HEADER_TIMEOUT_KEY = HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY;
const PROPS_PRIVATE_KEY = HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY;
const  PROPS_CERT_KEY = HDB_SETTINGS_NAMES.CERT_KEY;
const PROPS_HTTP_ON_KEY = HDB_SETTINGS_NAMES.HTTP_ENABLED_KEY;
const PROPS_HTTP_SECURE_ON_KEY = HDB_SETTINGS_NAMES.HTTP_SECURE_ENABLED_KEY;
const PROPS_HTTP_PORT_KEY = HDB_SETTINGS_NAMES.HTTP_PORT_KEY;
const PROPS_HTTP_SECURE_PORT_KEY = HDB_SETTINGS_NAMES.HTTP_SECURE_PORT_KEY;


const DEFAULT_SERVER_TIMEOUT = HDB_SETTINGS_DEFAULT_VALUES[PROPS_SERVER_TIMEOUT_KEY];
const DEFAULT_KEEP_ALIVE_TIMEOUT = HDB_SETTINGS_DEFAULT_VALUES[PROPS_SERVER_KEEP_ALIVE_TIMEOUT_KEY];
const DEFAULT_HEADER_TIMEOUT = HDB_SETTINGS_DEFAULT_VALUES[PROPS_HEADER_TIMEOUT_KEY];

let httpServer = undefined;
let secureServer = undefined;
let server_connections = {};

async function childServer() {
    harper_logger.info('In express' + process.cwd());
    harper_logger.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);

    global.clustering_on = false;

    process.on('message', handleServerMessage);

    process.on('uncaughtException', handleServerUncaughtException);

    process.on('close',() => {
        harper_logger.info(`Server close event received for process ${process.pid}`);
    });

    global.isMaster = cluster.isMaster;

    harper_logger.debug(`child process ${process.pid} starting up.`);
    await setUp();

    const props_http_secure_on = env.get(PROPS_HTTP_SECURE_ON_KEY);
    const props_http_on = env.get(PROPS_HTTP_ON_KEY);

    if (props_http_secure_on && (props_http_secure_on === true || props_http_secure_on.toUpperCase() === TRUE_COMPARE_VAL)) {
        secureServer = await buildServer(true);
    }

    if (props_http_on && (props_http_on === true || props_http_on.toUpperCase() === TRUE_COMPARE_VAL)) {
        httpServer = await buildServer(false);
    }
}

async function buildServer(is_https) {
    let server_opts = getServerOptions(is_https);
    const app = fastify(server_opts);
    //Fastify does not set this property in the initial app construction
    app.server.headersTimeout = getHeaderTimeoutConfig();

    const cors_options = getCORSOpts();
    if (cors_options) {
        await app.register(fastify_cors, cors_options);
    }

    //Register security headers for Fastify instance - https://helmetjs.github.io/
    await app.register(fastify_helmet);

    // This handles all get requests for the studio
    await app.register(fastify_compress);
    await app.register(fastify_static, {root: guidePath.join(__dirname,'../docs')});
    app.get('/', function(req, res) {
        return res.sendFile('index.html');
    });

    app.post('/', async function (req, res) {
        await handlePostRequest(req, res);
    });

    app.server.on('connection', function(socket) {
        let key = socket.remoteAddress + ':' + socket.remotePort;
        server_connections[key] = socket;
        socket.on('close', function() {
            harper_logger.debug(`removing connection for ${key}`);
            delete server_connections[key];
        });
    });

    try {
        if (is_https) {
            harper_logger.debug(`child process starting up https server.`);

            await app.listen(env.get(PROPS_HTTP_SECURE_PORT_KEY), '::')
                .then(address => {
                    harper_logger.info(`HarperDB ${pjson.version} HTTPS Server running on ${address}`);
                    signalling.signalChildStarted();
                }).catch(err => {
                    //TODO - add better error handling
                    console.log(err);
                });
        } else {
            harper_logger.debug(`child process starting up http server.`);

            await app.listen(env.get(PROPS_HTTP_PORT_KEY), '::')
                .then(address => {
                    harper_logger.info(`HarperDB ${pjson.version} HTTP Server running on ${address}`);
                    signalling.signalChildStarted();
                }).catch(err => {
                    //TODO - add better error handling
                    console.log(err);
                });
        }
        return app;
    } catch(e) {
        harper_logger.error(e);
    }
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

async function setUp(){
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

async function handlePostRequest(req, res) {
    // Per the body-parser docs, any request which does not match the bodyParser.json middleware will be returned with
    // an empty body object.
    if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST).send({error: "Invalid JSON."});
    }

    let user;
    let operation_function;
    try {
        //create_authorization_tokens needs to not authorize
        if (!req.body.operation || (req.body.operation && req.body.operation !== terms.OPERATIONS_ENUM.CREATE_AUTHENTICATION_TOKENS)) {
            user = await p_authorize(req, res);
        }
    } catch(err){
        harper_logger.warn(err);
        harper_logger.warn(`{"ip":"${req.socket.remoteAddress}", "error":"${err.stack}"`);
        if (typeof err === 'string') {
            return res.status(hdb_errors.HTTP_STATUS_CODES.UNAUTHORIZED).send({error: err});
        }
        return res.status(hdb_errors.HTTP_STATUS_CODES.UNAUTHORIZED).send({error:err.message});
    }

    req.body.hdb_user = user;
    req.body.hdb_auth_header = req.headers.authorization;

    try {
        operation_function = await p_choose_operation(req.body);
    } catch(error){
        harper_logger.error(error);
        if (error instanceof PermissionResponseObject) {
            return res.status(hdb_errors.HTTP_STATUS_CODES.FORBIDDEN).send(error);
        }
        if (error.http_resp_code) {
            if (typeof error.http_resp_msg === 'string') {
                return res.status(error.http_resp_code).send({error: error.http_resp_msg});
            }
            return res.status(error.http_resp_code).send(error.http_resp_msg);
        }
        if (typeof error === 'string') {
            return res.status(hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send({error: error});
        }
        return res.status(hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send(error);
    }
    server_utilities.processLocalTransaction(req, res, operation_function, function () {});
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
            let force = msg.force_shutdown === undefined ? true : msg.force_shutdown;
            shutDown(force).then(() => {
                harper_logger.info(`Completed shut down`);
                process.exit(terms.RESTART_CODE_NUM);
            });
            break;
        default:
            harper_logger.info(`Received unknown signaling message ${msg.type}, ignoring message`);
            break;
    }
}

function handleServerUncaughtException(err) {
    let message = `Found an uncaught exception with message: os.EOL ${err.message}.  Stack: ${err.stack} ${os.EOL} Terminating HDB.`;
    console.error(message);
    harper_logger.fatal(message);
    process.exit(1);
}

async function syncSchemaMetadata(msg){
    try{
        if(global.hdb_schema !== undefined && typeof global.hdb_schema === 'object' && msg.operation !== undefined){

            switch (msg.operation.operation) {
                case 'drop_schema':
                    delete global.hdb_schema[msg.operation.schema];
                    break;
                case 'drop_table':
                    if(global.hdb_schema[msg.operation.schema] !== undefined){
                        delete global.hdb_schema[msg.operation.schema][msg.operation.table];
                    }
                    break;
                case 'create_schema':
                    if(global.hdb_schema[msg.operation.schema] === undefined){
                        global.hdb_schema[msg.operation.schema] = {};
                    }
                    break;
                case 'create_table':
                case 'create_attribute':
                    if(global.hdb_schema[msg.operation.schema] === undefined){
                        global.hdb_schema[msg.operation.schema] = {};
                    }

                    global.hdb_schema[msg.operation.schema][msg.operation.table] =
                        await schema_describe.describeTable({schema: msg.operation.schema, table: msg.operation.table});
                    break;
                default:
                    global_schema.schemaSignal((err) => {
                        if (err) {
                            harper_logger.error(err);
                        }
                    });
                    break;
            }
        } else{
            global_schema.schemaSignal((err) => {
                if (err) {
                    harper_logger.error(err);
                }
            });
        }
    } catch(e){
        harper_logger.error(e);
    }
}

async function shutDown(force_bool) {
    harper_logger.debug(`Calling shutdown`);
    if (httpServer || secureServer) {
        //TODO - continue digging on whether or not this is necessary w/ Fastify. It seems like connections are being
        // handled internally on fastify.close but need to do more research to confirm.  In old hdb_express, we were not
        // using the force_bool in the method so also dig more to understand what that might have been used for in past.
        if (force_bool) {
            harper_logger.info(`Closing ${Object.keys(server_connections).length} server connections.`);
            for (let conn of Object.keys(server_connections)) {
                harper_logger.info(`Closing connection ${util.inspect(server_connections[conn])}`);
                server_connections[conn].destroy();
            }
        }
        setTimeout(() => {
            harper_logger.info(`Timeout occurred during client disconnect.  Took longer than ${terms.RESTART_TIMEOUT_MS}ms.`);
            hdb_util.callProcessSend({type: terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STOPPED, pid: process.pid});
        }, terms.RESTART_TIMEOUT_MS);
        if (httpServer) {
            try {
                await httpServer.close();
                harper_logger.debug(`Process pid:${process.pid} - http server closed`);
            } catch(err) {
                harper_logger.debug(`Process pid:${process.pid} - error closing http server - ${err}`);
            }
        }
        if (secureServer) {
            try {
                await secureServer.close();
                harper_logger.debug(`Process pid:${process.pid} - https server closed`);
            } catch (err) {
                harper_logger.debug(`Process pid:${process.pid} - error closing https server - ${err}`);
            }
        }
        harper_logger.info(`Process pid:${process.pid} - Work completed, shutting down`);
        hdb_util.callProcessSend({type: terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STOPPED, pid: process.pid});
    }
}

module.exports = childServer;
