"use strict";

const log = require('../utility/logging/harper_logger');
const env = require('../utility/environment/environmentManager');
const express = require('express');
const bodyParser = require('body-parser');
const auth = require('../security/auth');
const passport = require('passport');
const pjson = require('../package.json');
const server_utilities = require('./serverUtilities');
const cors = require('cors');
const uuidv1 = require('uuid/v1');
const user_schema = require('../utility/user_schema');
const async = require('async');
const insert = require('../data_layer/insert');
const job_runner = require('./jobRunner');
const guidePath = require('path');
const fs = require('fs');
const cluster_event = require('../events/ClusterStatusEmitter');
const signalling = require('../utility/signalling');
const moment = require('moment');
const hdb_terms = require('../utility/hdbTerms');
const global_schema = require('../utility/globalSchema');
const http = require('http');
const httpsecure = require('https');
const {promisify} = require('util');
const common = require('../utility/common_utils');

const DEFAULT_SERVER_TIMEOUT = 120000;
const PROPS_SERVER_TIMEOUT_KEY = 'SERVER_TIMEOUT_MS';
const PROPS_PRIVATE_KEY = 'PRIVATE_KEY';
const PROPS_CERT_KEY = 'CERTIFICATE';
const PROPS_HTTP_ON_KEY = 'HTTP_ON';
const PROPS_HTTP_SECURE_ON_KEY = 'HTTPS_ON';
const PROPS_HTTP_PORT_KEY = 'HTTP_PORT';
const PROPS_HTTP_SECURE_PORT_KEY = 'HTTPS_PORT';
const PROPS_CORS_KEY = 'CORS_ON';
const PROPS_CORS_WHITELIST_KEY = 'CORS_WHITELIST';
const TRUE_COMPARE_VAL = 'TRUE';

const app = express();
global.clusterMsgQueue = [];
let enterprise = false;

let props_cors = env.get(PROPS_CORS_KEY);
let props_cors_whitelist = env.get(PROPS_CORS_WHITELIST_KEY);
const p_auth_authorize = promisify(auth.authorize);
const p_server_util_choose_operation = promisify(server_utilities.chooseOperation);
const p_server_utils_process_local = promisify(server_utilities.processLocalTransaction);
const p_schema_get_table_schema = promisify(global_schema.getTableSchema);

function init() {
    log.info('In express' + process.cwd());

    //initialize the internal socket client
    //TODO only create this if clustering is active &  licensed
    require('./socketcluster/internalClient').init();

    log.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
    if (props_cors && (props_cors === true || props_cors.toUpperCase() === TRUE_COMPARE_VAL)) {
        let cors_options = {
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
        app.use(cors(cors_options));
    }

    app.use(bodyParser.json({limit: '1gb'})); // support json encoded bodies
    app.use(bodyParser.urlencoded({extended: true}));
    app.use(function (error, req, res, next) {
        if (error instanceof SyntaxError) {
            return sendHeaderResponse(req, res, hdb_terms.HTTP_STATUS_CODES.BAD_REQUEST, {error: 'invalid JSON: ' + error.message.replace('\n', '')});
        } else if (error) {
            return sendHeaderResponse(req, res, hdb_terms.HTTP_STATUS_CODES.BAD_REQUEST, {error: error.message});
        }
        return next();
    });

    app.use(passport.initialize());
    app.get('/', function (req, res) {
        auth.authorize(req, res, function () {
            res.sendFile(guidePath.resolve('../docs/user_guide.html'));
        });
    });
// Recent security posts recommend disabling this header.
    app.disable('x-powered-by');

    app.post('/', async(req,res, next) => {
        try {
            // Per the body-parser docs, any request which does not match the bodyParser.json middleware will be returned with
            // an empty body object.
            if(!req.body || Object.keys(req.body).length === 0) {
                return sendHeaderResponse(req, res, hdb_terms.HTTP_STATUS_CODES.BAD_REQUEST,{error: "Invalid JSON."});
            }
            let enterprise_operations = ['add_node'];
            if ((req.headers.harperdb_connection || enterprise_operations.indexOf(req.body.operation) > -1) && !enterprise) {
                return sendHeaderResponse(req, res, hdb_terms.HTTP_STATUS_CODES.UNAUTHORIZED, {"error": "This feature requires an enterprise license.  Please register or contact us at hello@harperdb.io for more info."});
            }

            let user = await auth.authorize(req, res, handleAuth);
            if(!user) {
                return sendHeaderResponse(req, res, hdb_terms.HTTP_STATUS_CODES.UNAUTHORIZED,{"error": "User not authorized."});
            }
            let response = await processMessage(req, res, user);
            log.debug('Finished processing message.');
        } catch(err) {
            log.error('There was an error in post to path "/".');
            log.error(err);
            return sendHeaderResponse(req, res, hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, {error: err});
        }
    });

    process.on('message', (msg) => {
        switch (msg.type) {
            case 'schema':
                global_schema.schemaSignal((err) => {
                    if (err) {
                        log.error(err);
                    }
                });
                break;
            case 'user':
                user_schema.setUsersToGlobal((err) => {
                    if (err) {
                        log.error(err);
                    }
                });
                break;
            case 'job':
                job_runner.parseMessage(msg.runner_message).then((result) => {
                    log.info(`completed job with result ${result}`);
                }).catch(function isError(e) {
                    log.error(e);
                });
                break;
            case 'enterprise':
                enterprise = msg.enterprise;
                break;
            case 'clustering':
                global.clustering_on = true;
                break;
            case 'cluster_response':
                try {
                    if (global.clusterMsgQueue[msg.id]) {
                        if (msg.err) {
                            global.clusterMsgQueue[msg.id].status(hdb_terms.HTTP_STATUS_CODES.UNAUTHORIZED).json({"error": msg.err});
                            delete global.clusterMsgQueue[msg.id];
                            break;
                        }


                        global.clusterMsgQueue[msg.id].status(hdb_terms.HTTP_STATUS_CODES.OK).json(msg.data);
                        delete global.clusterMsgQueue[msg.id];
                    }
                } catch(err) {
                    log.error(err);
                }
                break;
            case 'delegate_transaction':
                server_utilities.chooseOperation(msg.body, function (err, operation_function) {
                    server_utilities.processInThread(msg.body, operation_function, function (err, data) {
                        process.send({"type": "delegate_thread_response", "err": err, "data": data, "id": msg.id});
                    });
                });
                break;
            case hdb_terms.CLUSTER_MESSAGE_TYPE_ENUM.CLUSTER_STATUS:
                log.info('Got cluster status message via IPC');
                cluster_event.clusterEmitter.emit(cluster_event.EVENT_NAME, msg.status);
                break;
            default:
                log.error(`Received unknown signaling message ${msg.type}, ignoring message`);
                break;
        }
    });

    process.on('uncaughtException', function (err) {
        console.error(`HarperDB has encountered an unrecoverable error.  Please check the logs and restart.`);
        log.fatal(`Found an uncaught exception with message: os.EOL ${err.message}.  Stack: ${err.stack}. Terminating HDB.`);
        process.exit(1);
    });

    try {
        const privateKey = env.get(PROPS_PRIVATE_KEY);
        const certificate = env.get(PROPS_CERT_KEY);
        const credentials = {key: fs.readFileSync(`${privateKey}`), cert: fs.readFileSync(`${certificate}`)};
        const server_timeout = env.get(PROPS_SERVER_TIMEOUT_KEY);
        const props_http_secure_on = env.get(PROPS_HTTP_SECURE_ON_KEY);
        const props_http_on = env.get(PROPS_HTTP_ON_KEY);

        let httpServer = undefined;
        let secureServer = undefined;

        if (props_http_secure_on &&
            (props_http_secure_on === true || props_http_secure_on.toUpperCase() === TRUE_COMPARE_VAL)) {
            secureServer = httpsecure.createServer(credentials, app);
            secureServer.setTimeout(server_timeout ? server_timeout : DEFAULT_SERVER_TIMEOUT);
            secureServer.listen(env.get(PROPS_HTTP_SECURE_PORT_KEY), function () {
                log.info(`HarperDB ${pjson.version} HTTPS Server running on ${env.get(PROPS_HTTP_SECURE_PORT_KEY)}`);
                async.parallel(
                    [
                        global_schema.setSchemaDataToGlobal,
                        user_schema.setUsersToGlobal,
                        signalling.signalChildStarted
                    ], (error) => {
                        if (error) {
                            log.error(error);
                        }
                    });
            });
        }

        if (props_http_on &&
            (props_http_on === true || props_http_on.toUpperCase() === TRUE_COMPARE_VAL)) {
            httpServer = http.createServer(app);
            httpServer.setTimeout(server_timeout ? server_timeout : DEFAULT_SERVER_TIMEOUT);
            httpServer.listen(env.get(PROPS_HTTP_PORT_KEY), function (err) {
                if(err) {
                    log.error(err);
                }
                log.info(`HarperDB ${pjson.version} HTTP Server running on ${env.get(PROPS_HTTP_PORT_KEY)}`);
                async.parallel(
                    [
                        global_schema.setSchemaDataToGlobal,
                        user_schema.setUsersToGlobal,
                        signalling.signalChildStarted
                    ], (error) => {
                        if (error) {
                            log.error(error);
                        }
                    });
            });
        }
    } catch (e) {
        log.error(e);
    }
}

/**
 * Called as next() during auth so we can return the found user.
 * @param err - Errors found during auth
 * @param user - User found during auth.
 * @returns {*}
 */
function handleAuth(err, user) {
    if(err) {
        log.error('There was an error with auth.');
    } else {
        return user;
    }
}

/**
 * Helper function to determine the residence for the inbound message.  For messages that do not require a table to be
 * specified, we assume * for non local operations, and NODE_NAME for local operations.
 * @param req
 * @returns Array
 */
function determineMessageResidence(req) {
    let residences = [];
        // table was specified, try to get the residences for this table.
    try {
        let table = global.hdb_schema[req.body.schema][req.body.table];
        if(table) {
            if(table.residence) {
                residences = table.residence;
            }
        }
    } catch(err) {
        log.info(`Could not find existing table residence.  Assuming *.`);
    }
    return residences;
}

/**
 * Function the defines how an inbound message meant for the cluster is handled.
 * @param req - request object
 * @param res - response object
 * @param operation_function - function specified in the inbound object.
 * @returns {Promise<*>}
 */
async function processClusterMessage(req, res, operation_function) {
    log.trace('processing cluster message');

    let result = null;
    let cluster_msg_id = uuidv1();
    try {
        let residences = determineMessageResidence(req);
        if(!residences || residences.length === 0) {
            let result = await processLocalMessage(req, res, operation_function);
            return result;
        }

        // We are going to reference this later when we decide how to respond to the requestor.  If we didn't process any
        // local tables, we will respond by saying the message has been broadcast.  Otherwise respond as normal.
        let against_local_table = false;
        for (let node of residences) {
            if (node !== "*" && node !== env.get('NODE_NAME')) {
                log.debug(`Got a message for a table with a remote residence ${node}.  Broadcasting to cluster`);
                global.clusterMsgQueue[cluster_msg_id] = res;
                common.callProcessSennd({
                    "type": "clustering_payload", "pid": process.pid,
                    "clustering_type": "send",
                    "id": cluster_msg_id,
                    "body": req.body,
                    "node": {"name": node}
                });
            } else if(node === "*" || node === env.get('NODE_NAME')) {
                result = await p_server_utils_process_local(req, res, operation_function);
                against_local_table = true;
                if(node === "*" && !hdb_terms.LOCAL_HARPERDB_OPERATIONS.includes(req.body.operation)) {
                    common.callProcessSend({
                        "type": "clustering_payload", "pid": process.pid,
                        "clustering_type": "broadcast",
                        "id": cluster_msg_id,
                        "body": req.body
                    });
                }
            }
            // Add to hdb_queue
            if(!hdb_terms.LOCAL_HARPERDB_OPERATIONS.includes(req.body.operation)) {
                let item = {
                    "payload": {"body": req.body, "id": cluster_msg_id},
                    "id": cluster_msg_id,
                    "node": {"node": node},
                    "node_name": node,
                    "timestamp": moment.utc().valueOf()
                };

                let insert_object = {
                    operation: 'insert',
                    schema: 'system',
                    table: 'hdb_queue',
                    records: [item]
                };
                let insert_result = await insert.insert(insert_object);
                log.trace(`Inserted ${insert_result} into hdb_queue`);
            }
        }

        if(!against_local_table) {
            // We need to manually set and send the status here, as processLocal isn't called.
            log.debug('only processed remote table residence, notifying of broadcast');
            return sendHeaderResponse(req, res, hdb_terms.HTTP_STATUS_CODES.OK).send({message: `Specified table has residence on node(s): ${residences.join()}; broadcasting message to cluster.`});
        }
    } catch(err) {
        log.error(err);
        return sendHeaderResponse(req, res, hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,{error: err.message});
    }
    return result;
}

/**
 * This should be called in order to respond to a requestor.  ProcessLocal should handle most cases, but if anything
 * falls through we want to make sure to respond.  This provides a check to ensure the header has not already been sent.
 * @param err_code - error code as defined in hdb_terms.HTTP_STATUS_CODES
 * @param err_json - json formatted error message.
 */
function sendHeaderResponse(req, res, err_code, err_json) {
    if(!res._headerSent) {
        return res.status(err_code).send(err_json);
    }
}

/**
 * Processes messages meant only for this local node, will not be sent to the cluster.
 * @param req - request object
 * @param res - response object
 * @param operation_function - function specified in the inbound object.
 * @returns {Promise<*>}
 */
async function processLocalMessage(req, res, operation_function) {
    let result = null;
    try {
        result = await p_server_utils_process_local(req, res, operation_function);
    } catch(err) {
        log.error(err);
    }
    return result;
}

/**
 * Helper function to decide how to process the inbound message.
 * @param req - the request
 * @param res - the response
 * @param user - User returned from auth call.
 * @returns {Promise<*>}
 */
async function processMessage(req, res, user) {
    try {
        req.body.hdb_user = user;
        req.body.hdb_auth_header = req.headers.authorization;

        let operation_function = await p_server_util_choose_operation(req.body);

        let process_result = null;
        // check for clustering
        if(env.get(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY)) {
            if(req.body.operation === 'sql') {
                process_result = await processLocalMessage(req,res, operation_function);
            } else {
                process_result = await processClusterMessage(req, res, operation_function);
            }
        } else {
            process_result = await processLocalMessage(req, res, operation_function);
        }
    } catch(err) {
        log.error(err);
        if (err === server_utilities.UNAUTH_RESPONSE) {
            return sendHeaderResponse(req, res, hdb_terms.HTTP_STATUS_CODES.FORBIDDEN, {error: server_utilities.UNAUTHORIZED_TEXT});
        }
        if (typeof err === 'string') {
            return sendHeaderResponse(req, res, hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, {error: err});
        }
        return sendHeaderResponse(req, res, hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,{error: err});
    }
}

module.exports = {
    init: init
};
