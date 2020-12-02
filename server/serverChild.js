"use strict";

const cluster = require('cluster');
const env = require('../utility/environment/environmentManager');
const terms = require('../utility/hdbTerms');
const hdb_util = require('../utility/common_utils');
const os = require('os');
const util = require('util');

const harper_logger = require('../utility/logging/harper_logger');
const fs = require('fs');
const fastify = require('fastify');
// const bodyParser = require('body-parser');
const auth = require('../security/auth');
const p_authorize = util.promisify(auth.authorize);

// const passport = require('passport');
const pjson = require(`${__dirname}/../package.json`);
const server_utilities = require('./serverUtilities');
const p_choose_operation = util.promisify(server_utilities.chooseOperation);
const cors = require('fastify-cors');
const fastify_compress = require('fastify-compress');
const fastify_static = require('fastify-static');
const fastify_helmet = require('fastify-helmet');
const spawn_cluster_connection = require('./socketcluster/connector/spawnSCConnection');

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
const PROPS_CORS_KEY = 'CORS_ON';
const PROPS_CORS_WHITELIST_KEY = 'CORS_WHITELIST';
const TRUE_COMPARE_VAL = 'TRUE';
const DEFAULT_SERVER_TIMEOUT = 120000;
const PROPS_SERVER_TIMEOUT_KEY = 'SERVER_TIMEOUT_MS';
const PROPS_PRIVATE_KEY = 'PRIVATE_KEY';
const PROPS_CERT_KEY = 'CERTIFICATE';
const PROPS_HTTP_ON_KEY = 'HTTP_ON';
const PROPS_HTTP_SECURE_ON_KEY = 'HTTPS_ON';
const PROPS_HTTP_PORT_KEY = 'HTTP_PORT';
const PROPS_HTTP_SECURE_PORT_KEY = 'HTTPS_PORT';

// const http = require('http');
// const httpsecure = require('https');

const privateKey = env.get(PROPS_PRIVATE_KEY);
const certificate = env.get(PROPS_CERT_KEY);
const credentials = {key: fs.readFileSync(`${privateKey}`), cert: fs.readFileSync(`${certificate}`)};
const server_timeout = env.get(PROPS_SERVER_TIMEOUT_KEY) ? env.get(PROPS_SERVER_TIMEOUT_KEY) : DEFAULT_SERVER_TIMEOUT;
const props_http_secure_on = env.get(PROPS_HTTP_SECURE_ON_KEY);
const props_http_on = env.get(PROPS_HTTP_ON_KEY);
let keep_alive_timeout = env.get(terms.HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY);
let headers_timeout = env.get(terms.HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY);

let app;
let httpServer = undefined;
let secureServer = undefined;
let server_connections = {};

const fastify_options = {
    bodyLimit: REQ_MAX_BODY_SIZE,
    connectionTimeout: server_timeout ? server_timeout : DEFAULT_SERVER_TIMEOUT,
    keepAliveTimeout: keep_alive_timeout ? keep_alive_timeout : null,
    headersTimeout: headers_timeout ?  headers_timeout : null
};

let props_cors = env.get(PROPS_CORS_KEY);
let props_cors_whitelist = env.get(PROPS_CORS_WHITELIST_KEY);
let cors_options;

function serverChild() {
    harper_logger.info('In express' + process.cwd());
    harper_logger.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);

    global.clustering_on = false;

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

    process.on('message', handleServerMessage);

    process.on('uncaughtException', handleServerUncaughtException);

    process.on('close',() => {
        harper_logger.info(`Server close event received for process ${process.pid}`);
    });

    global.isMaster = cluster.isMaster;

    harper_logger.debug(`child process ${process.pid} starting up.`);
    setUp().then(()=>{});

    if (props_http_secure_on &&
        (props_http_secure_on === true || props_http_secure_on.toUpperCase() === TRUE_COMPARE_VAL)) {

        secureServer = buildServer(true);

        // secureServer.listen(env.get(PROPS_HTTP_SECURE_PORT_KEY), function () {
        //     harper_logger.info(`HarperDB ${pjson.version} HTTPS Server running on ${env.get(PROPS_HTTP_SECURE_PORT_KEY)}`);
        //     signalling.signalChildStarted();
        // });
    }

    if (props_http_on &&
        (props_http_on === true || props_http_on.toUpperCase() === TRUE_COMPARE_VAL)) {

        httpServer = buildServer(false);

        httpServer.server.on('connection', function(conn) {
            let key = conn.remoteAddress + ':' + conn.remotePort;
            server_connections[key] = conn;
            conn.on('close', function() {
                harper_logger.debug(`removing connection for ${key}`);
                delete server_connections[key];
            });
        });

        // httpServer.listen(env.get(PROPS_HTTP_PORT_KEY), function () {
        //     harper_logger.info(`HarperDB ${pjson.version} HTTP Server running on ${env.get(PROPS_HTTP_PORT_KEY)}`);
        //     signalling.signalChildStarted();
        // });
    }
}

function buildServer(is_https) {
    let server_opts = Object.assign({}, fastify_options);
    if (is_https) {
        server_opts.https = credentials;
    }
    const app = fastify(fastify_options);

    app.register(fastify_helmet);

    if (props_cors && (props_cors === true || props_cors.toUpperCase() === TRUE_COMPARE_VAL)) {
        app.register(cors, cors_options);
    }

    //TODO THIS CODE IS COMMENTED OUT AS IT IS SUPERCEDED WITH FASTIFY NATIVELY CONVERTING THE REQUEST BODY TO JSON,
    // HOWEVER PLEASE MAKE SURE THIS CODE CAN BE FULL REMOVED
    /*
    app.use(bodyParser.json({limit: '1gb'})); // support json encoded bodies
    app.use(bodyParser.urlencoded({extended: true}));
    app.use(function (error, req, res, next) {
        if (error instanceof SyntaxError) {
            res.status(hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST).send({error: 'invalid JSON: ' + error.message.replace('\n', '')});
        } else if (error) {
            res.status(hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST).send({error: error.message});
        } else {
            next();
        }
    });

    app.use(passport.initialize());*/

// This handles all get requests for the studio
    app.register(fastify_compress);
    app.register(fastify_static, {root: guidePath.join(__dirname,'../docs')});
    app.get('/', function(req, res) {
        return res.sendFile('index.html');
    });

    app.post('/',async function (req, res) {
        await handlePostRequest(req, res);
    });

    try {
        // const http = require('http');
        // const httpsecure = require('https');
        //
        // const privateKey = env.get(PROPS_PRIVATE_KEY);
        // const certificate = env.get(PROPS_CERT_KEY);
        // const credentials = {key: fs.readFileSync(`${privateKey}`), cert: fs.readFileSync(`${certificate}`)};
        // const server_timeout = env.get(PROPS_SERVER_TIMEOUT_KEY);
        // const props_http_secure_on = env.get(PROPS_HTTP_SECURE_ON_KEY);
        // const props_http_on = env.get(PROPS_HTTP_ON_KEY);

        //TODO we need to be able to create a http & https endpoint based on config, this code will be refactored to
        // accomplish this with fastify in the next PR (CORE-1181)
        // let keep_alive_timeout = env.get(terms.HDB_SETTINGS_NAMES.SERVER_KEEP_ALIVE_TIMEOUT_KEY);
        // let headers_timeout = env.get(terms.HDB_SETTINGS_NAMES.SERVER_HEADERS_TIMEOUT_KEY);

        if (is_https) {
            app.listen(env.get(PROPS_HTTP_SECURE_PORT_KEY), function () {
                harper_logger.info(`HarperDB ${pjson.version} HTTPS Server running on ${env.get(PROPS_HTTP_SECURE_PORT_KEY)}`);
                signalling.signalChildStarted();
            });
        } else {
            harper_logger.debug(`child process starting up http server.`);
            // app.server.on('connection', function(conn) {
            //     let key = conn.remoteAddress + ':' + conn.remotePort;
            //     server_connections[key] = conn;
            //     conn.on('close', function() {
            //         harper_logger.debug(`removing connection for ${key}`);
            //         delete server_connections[key];
            //     });
            // });

            app.listen(env.get(PROPS_HTTP_PORT_KEY), function () {
                harper_logger.info(`HarperDB ${pjson.version} HTTP Server running on ${env.get(PROPS_HTTP_PORT_KEY)}`);
                signalling.signalChildStarted();
            });
        }
        return app;
    } catch(e) {
        harper_logger.error(e);
    }
}

//TODO - THIS METHOD WILL BE REMOVED WHEN THE SERVER FACTORY METHOD IS ADDED IN NEXT PR (CORE-1181)
//function tempServerListener() {
//     app.listen("9925",'0.0.0.0', (err, address) => {
//         if (err) {
//             console.error(err);
//             process.exit(1);
//         }
//         harper_logger.info(`HarperDB ${pjson.version} HTTP Server running on ${env.get(PROPS_HTTP_PORT_KEY)}`);
//         signalling.signalChildStarted();
//         console.log('running on ' + address);
//         //tracer.use('fastify');
//         process.on('SIGINT', () => app.close());
//         process.on('SIGTERM', () => app.close());
//     });
// }

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
        harper_logger.warn(`{"ip":"${req.connection.remoteAddress}", "error":"${err.stack}"`);
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

function handleServerMessage(msg) {
    switch (msg.type) {
        case 'schema':
            removeSchemaFromLMDBMap(msg);
            global_schema.schemaSignal((err) => {
                if (err) {
                    harper_logger.error(err);
                }
            });
            break;
        case 'user':
            user_schema.setUsersToGlobal((err) => {
                if (err) {
                    harper_logger.error(err);
                }
            });
            break;
        case 'job':
            job_runner.parseMessage(msg.runner_message).then((result) => {
                harper_logger.info(`completed job with result: ${JSON.stringify(result)}`);
            }).catch((e) => {
                harper_logger.error(e);
            });
            break;
        case terms.CLUSTER_MESSAGE_TYPE_ENUM.RESTART:
            harper_logger.info(`Server close event received for process ${process.pid}`);
            harper_logger.debug(`calling shutdown`);
            let force = (msg.force_shutdown === undefined? true : msg.force_shutdown);
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

/**
 * this function strips away the cached environments from global when a schema item is removed
 * @param msg
 */
function removeSchemaFromLMDBMap(msg){
    try{
        if(global.lmdb_map !== undefined && msg.operation !== undefined){
            let keys = Object.keys(global.lmdb_map);
            let cached_environment = undefined;
            switch (msg.operation.operation) {
                case 'drop_schema':
                    for(let x = 0; x < keys.length; x ++){
                        let key = keys[x];
                        if(key.startsWith(`${msg.operation.schema}.`) || key.startsWith(`txn.${msg.operation.schema}.`)){
                            delete global.lmdb_map[key];
                            delete global.lmdb_map[`txn.${key}`];
                        }
                    }
                    break;
                case 'drop_table':
                    delete global.lmdb_map[`${msg.operation.schema}.${msg.operation.table}`];
                    delete global.lmdb_map[`txn.${msg.operation.schema}.${msg.operation.table}`];
                    break;
                case 'drop_attribute':
                    cached_environment = global.lmdb_map[`${msg.operation.schema}.${msg.operation.table}`];
                    if(cached_environment !== undefined && typeof cached_environment.dbis === 'object' && cached_environment.dbis[`${msg.operation.attribute}`] !== undefined){
                        delete cached_environment.dbis[`${msg.operation.attribute}`];
                    }
                    break;
                default:
                    break;
            }
        }
    } catch(e){
        harper_logger.error(e);
    }
}

async function shutDown(force_bool) {
    harper_logger.debug(`calling shutdown`);
    let target_server = (httpServer ? httpServer : secureServer);
    if(target_server) {
        harper_logger.warn(`Process pid:${process.pid} - SIGINT received, closing connections and finishing existing work.`);
        harper_logger.info(`There are ${Object.keys(server_connections).length} connections.`);
        for (let conn of Object.keys(server_connections)) {
            harper_logger.info(`Closing connection ${util.inspect(server_connections[conn])}`);
            server_connections[conn].destroy();
        }
        setTimeout(() => {
            harper_logger.info(`Timeout occurred during client disconnect.  Took longer than ${terms.RESTART_TIMEOUT_MS}ms.`);
            hdb_util.callProcessSend({type: terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STOPPED, pid: process.pid});
        }, terms.RESTART_TIMEOUT_MS);
        target_server.close(function () {
            harper_logger.warn(`Process pid:${process.pid} - Work completed, shutting down`);
            hdb_util.callProcessSend({type: terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STOPPED, pid: process.pid});
        });
    }
}

module.exports = serverChild;
