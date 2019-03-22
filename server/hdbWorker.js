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
            res.status(hdb_terms.HTTP_STATUS_CODES.BAD_REQUEST).send({error: 'invalid JSON: ' + error.message.replace('\n', '')});
        } else if (error) {
            res.status(hdb_terms.HTTP_STATUS_CODES.BAD_REQUEST).send({error: error.message});
        } else {
            return next();
        }
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
                return res.status(hdb_terms.HTTP_STATUS_CODES.BAD_REQUEST).send({error: "Invalid JSON."});
            }
            let enterprise_operations = ['add_node'];
            if ((req.headers.harperdb_connection || enterprise_operations.indexOf(req.body.operation) > -1) && !enterprise) {
                return res.status(hdb_terms.HTTP_STATUS_CODES.UNAUTHORIZED).json({"error": "This feature requires an enterprise license.  Please register or contact us at hello@harperdb.io for more info."});
            }

            let user = await auth.authorize(req, res, handleAuth);
            if(!user) {
                // TODO: make sure this response matches old failed log in response.
                return res.status(hdb_terms.HTTP_STATUS_CODES.UNAUTHORIZED).json({"error": "User not authorized."});
            }
            let response = await processMessage(req, res, user);
            log.info('Were here.');
        } catch(err) {
            log.error('There was an error in post to path "/".');
            log.error(err);
        }
    });

    /*
    app.post('/', function (req, res) {
        // Per the body-parser docs, any request which does not match the bodyParser.json middleware will be returned with
        // an empty body object.
        if(!req.body || Object.keys(req.body).length === 0) {
            return res.status(hdb_terms.HTTP_STATUS_CODES.BAD_REQUEST).send({error: "Invalid JSON."});
        }
        let enterprise_operations = ['add_node'];
        if ((req.headers.harperdb_connection || enterprise_operations.indexOf(req.body.operation) > -1) && !enterprise) {
            return res.status(hdb_terms.HTTP_STATUS_CODES.UNAUTHORIZED).json({"error": "This feature requires an enterprise license.  Please register or contact us at hello@harperdb.io for more info."});
        }
        auth.authorize(req, res, function (err, user) {
            if (err) {
                log.warn(`{"ip":"${req.connection.remoteAddress}", "error":"${err.stack}"`);
                if (typeof err === 'string') {
                    return res.status(hdb_terms.HTTP_STATUS_CODES.UNAUTHORIZED).send({error: err});
                }
                return res.status(hdb_terms.HTTP_STATUS_CODES.UNAUTHORIZED).send(err);
            }
            req.body.hdb_user = user;
            req.body.hdb_auth_header = req.headers.authorization;

            server_utilities.chooseOperation(req.body, (err, operation_function) => {
                if (err) {
                    log.error(err);
                    if(err === server_utilities.UNAUTH_RESPONSE) {
                        return res.status(hdb_terms.HTTP_STATUS_CODES.FORBIDDEN).send({error: server_utilities.UNAUTHORIZED_TEXT});
                    }
                    if (typeof err === 'string') {
                        return res.status(hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send({error: err});
                    }
                    return res.status(hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send(err);
                }

                if (global.clustering_on && req.body.operation !== 'sql') {
                    if (!req.body.schema
                        || !req.body.table
                        || req.body.operation === 'create_table'
                        || req.body.operation === 'drop_table'
                        || req.body.operation === 'delete_files_before'
                    ) {
                        if (hdb_terms.LOCAL_HARPERDB_OPERATIONS.includes(req.body.operation)) {
                            log.info('local only operation: ' + req.body.operation);
                            server_utilities.processLocalTransaction(req, res, operation_function, function (err) {
                                if(err){
                                    log.error(err);
                                }
                            });
                        } else {
                            log.info('local & delegated operation: ' + req.body.operation);
                            server_utilities.processLocalTransaction(req, res, operation_function, function (err) {
                                if(err){
                                    log.error('error from local & delegated: ' + JSON.stringify(err));
                                }else {
                                    let id = uuidv1();
                                    process.send({
                                        "type": "clustering_payload", "pid": process.pid,
                                        "clustering_type": "broadcast",
                                        "id": id,
                                        "body": req.body
                                    });

                                }
                            });
                        }
                    } else {
                        global_schema.getTableSchema(req.body.schema, req.body.table, function (err, table) {
                            if (err) {
                                log.error(err);
                                return res.status(hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send(err);
                            }
                            if (table.residence) {
                                let residence = table.residence;
                                if (typeof table.residence === 'string') {
                                    residence = JSON.parse(table.residence);
                                }

                                if (residence.indexOf('*') > -1) {
                                    server_utilities.processLocalTransaction(req, res, operation_function, function (err) {
                                        if (!err) {
                                            let id = uuidv1();
                                            process.send({
                                                "type": "clustering_payload", "pid": process.pid,
                                                "clustering_type": "broadcast",
                                                "id": id,
                                                "body": req.body
                                            });
                                        }
                                    });
                                } else {

                                    if (residence.indexOf(env.get('NODE_NAME')) > -1) {
                                        server_utilities.processLocalTransaction(req, res, operation_function, function (err) {
                                            if(err) {
                                                log.error(err);
                                            }
                                            if (residence.length > 1) {
                                                for (let node in residence) {
                                                    if (residence[node] !== env.get('NODE_NAME')) {

                                                        let id = uuidv1();
                                                        process.send({
                                                            "type": "clustering_payload", "pid": process.pid,
                                                            "clustering_type": "send",
                                                            "id": id,
                                                            "body": req.body,
                                                            "node": {"name": residence[node]}
                                                        });
                                                    }
                                                }
                                            }
                                        });
                                    } else {
                                        for (let node in residence) {
                                            if (residence[node] !== env.get('NODE_NAME')) {
                                                log.debug(`Got a message for a table with a remote residence ${residence[node]}.  Broadcasting to cluster`);
                                                let id = uuidv1();
                                                global.clusterMsgQueue[id] = res;

                                                try {
                                                    process.send({
                                                        "type": "clustering_payload", "pid": process.pid,
                                                        "clustering_type": "send",
                                                        "id": id,
                                                        "body": req.body,
                                                        "node": {"name": residence[node]}
                                                    });

                                                } catch(err) {
                                                    log.error(err);
                                                    return res.status(hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send({error: err.message});
                                                }
                                            }
                                        }
                                        // We need to manually set and send the status here, as processLocal isn't called.
                                        return res.status(hdb_terms.HTTP_STATUS_CODES.OK).send({message: `Specified table has residence on node(s): ${residence.join()}; broadcasting message to cluster.`});
                                    }
                                }
                            } else {
                                server_utilities.processLocalTransaction(req, res, operation_function, function () {
                                    //no-op
                                });
                            }
                        });
                    }
                } else if(req.body.schema && req.body.table
                    && req.body.operation !== 'create_table' && req.body.operation !=='drop_table' && !hdb_terms.LOCAL_HARPERDB_OPERATIONS.includes(req.body.operation) ) {

                    global_schema.getTableSchema(req.body.schema, req.body.table, function (err, table) {

                        if(!table || !table.residence || table.residence.indexOf(env.get('NODE_NAME')) > -1){
                            server_utilities.processLocalTransaction(req, res, operation_function, function () {
                            });
                        }else{
                            try {
                                async.forEach(table.residence, function(residence, callback_){
                                    let id = uuidv1();
                                    let item = {
                                        "payload": {"body":req.body, "id": id},
                                        "id": id,
                                        "node": {"node": residence},
                                        "node_name": residence,
                                        "timestamp": moment.utc().valueOf()
                                    };

                                    let insert_object = {
                                        operation: 'insert',
                                        schema: 'system',
                                        table: 'hdb_queue',
                                        records: [item]
                                    };

                                    insert.insertCB(insert_object, function (err) {
                                        if (err) {
                                            log.error(err);
                                            return callback_(err);
                                        }
                                        return callback_();
                                    });
                                }, function(err){
                                    if(err){
                                        return res.status(hdb_terms.HTTP_STATUS_CODES.NOT_IMPLEMENTED).send(err);
                                    }
                                    return res.status(hdb_terms.HTTP_STATUS_CODES.CREATED).send('{"message":"clustering is down. request has been queued and will be processed when clustering reestablishes.  "}');
                                });
                            } catch (e) {
                                log.error(e);
                            }
                        }
                    });
                }else{
                    server_utilities.processLocalTransaction(req, res, operation_function, function () {
                    });
                }
            });
        });
    }); */

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

function handleAuth(err, user) {
    if(err) {
        log.error('There was an error with auth.');
    } else {
        return user;
    }
}

async function processClusterMessage(req, res) {
    log.trace('processing cluster message');

    let result = null;
    try {
        let table = await p_schema_get_table_schema(req.body.schema, req.body.table);
        // We are going to reference this later when we decide how to respond to the requestor.  If we didn't process any
        // local tables, we will respond by saying the message has been broadcast.  Otherwise respond as normal.
        let against_local_table = false;
        for (let node of table.residence) {
            if (node !== env.get('NODE_NAME')) {
                log.debug(`Got a message for a table with a remote residence ${node}.  Broadcasting to cluster`);
                let id = uuidv1();
                global.clusterMsgQueue[id] = res;
                process.send({
                    "type": "clustering_payload", "pid": process.pid,
                    "clustering_type": "send",
                    "id": id,
                    "body": req.body,
                    "node": {"name": node}
                });
            } else if(node === "*" || node === env.get('NODE_NAME')) {
                result = await p_server_utils_process_local(req, res);
                against_local_table = true;
                if(node === "*" && !hdb_terms.LOCAL_HARPERDB_OPERATIONS.includes(req.body.operation)) {
                    let id = uuidv1();
                    process.send({
                        "type": "clustering_payload", "pid": process.pid,
                        "clustering_type": "broadcast",
                        "id": id,
                        "body": req.body
                    });
                }
            }
        }
        if(!against_local_table) {
            // We need to manually set and send the status here, as processLocal isn't called.
            log.debug('only processed remote table residence, notifying of broadcast');
            return res.status(hdb_terms.HTTP_STATUS_CODES.OK).send({message: `Specified table has residence on node(s): ${residence.join()}; broadcasting message to cluster.`});
        }
    } catch(err) {
        log.error(err);
        return res.status(hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send({error: err.message});
    }
    return result;
}

async function processLocalMessage(req, res) {
    let result = null;
    try {
        result = await p_server_utils_process_local(req, res);
        if (!hdb_terms.LOCAL_HARPERDB_OPERATIONS.includes(req.body.operation)) {
            let id = uuidv1();
            process.send({
                "type": "clustering_payload", "pid": process.pid,
                "clustering_type": "broadcast",
                "id": id,
                "body": req.body
            });
        }
    } catch(err) {
        log.error(err);
    }
    return result;
}

async function processMessage(req, res, user) {
    try {
        /*if (err) {
            log.warn(`{"ip":"${req.connection.remoteAddress}", "error":"${err.stack}"`);
            if (typeof err === 'string') {
                return res.status(hdb_terms.HTTP_STATUS_CODES.UNAUTHORIZED).send({error: err});
            }
            return res.status(hdb_terms.HTTP_STATUS_CODES.UNAUTHORIZED).send(err);
        }*/


        req.body.hdb_user = user;
        req.body.hdb_auth_header = req.headers.authorization;

        let operation_function = await p_server_util_choose_operation(req.body);

        let process_result = null;
        // check for clustering
        if(global.clustering_on) {
            if(req.body.operation === 'sql') {
                process_result = processLocalMessage(req,res);
            } else {
                process_result = processClusterMessage(req, res);
            }
        } else {
            process_result = processLocalMessage(req, res);
        }

        if (global.clustering_on && req.body.operation !== 'sql') {
            if (!req.body.schema
                || !req.body.table
                || req.body.operation === 'create_table'
                || req.body.operation === 'drop_table'
                || req.body.operation === 'delete_files_before'
            ) {
                //let result = await p_server_utils_process_local(req, res, operation_function);
                if (hdb_terms.LOCAL_HARPERDB_OPERATIONS.includes(req.body.operation)) {
                    log.info('local only operation: ' + req.body.operation);
                    server_utilities.processLocalTransaction(req, res, operation_function, function (err) {
                        if (err) {
                            log.error(err);
                        }
                    });
                } else {
                    log.info('local & delegated operation: ' + req.body.operation);
                    server_utilities.processLocalTransaction(req, res, operation_function, function (err) {
                        if (err) {
                            log.error('error from local & delegated: ' + JSON.stringify(err));
                        } else {
                            let id = uuidv1();
                            process.send({
                                "type": "clustering_payload", "pid": process.pid,
                                "clustering_type": "broadcast",
                                "id": id,
                                "body": req.body
                            });

                        }
                    });
                }
            } else {
                global_schema.getTableSchema(req.body.schema, req.body.table, function (err, table) {
                    if (err) {
                        log.error(err);
                        return res.status(hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send(err);
                    }
                    if (table.residence) {
                        let residence = table.residence;
                        if (typeof table.residence === 'string') {
                            residence = JSON.parse(table.residence);
                        }

                        if (residence.indexOf('*') > -1) {
                            server_utilities.processLocalTransaction(req, res, operation_function, function (err) {
                                if (!err) {
                                    let id = uuidv1();
                                    process.send({
                                        "type": "clustering_payload", "pid": process.pid,
                                        "clustering_type": "broadcast",
                                        "id": id,
                                        "body": req.body
                                    });
                                }
                            });
                        } else {

                            if (residence.indexOf(env.get('NODE_NAME')) > -1) {
                                server_utilities.processLocalTransaction(req, res, operation_function, function (err) {
                                    if (err) {
                                        log.error(err);
                                    }
                                    if (residence.length > 1) {
                                        for (let node in residence) {
                                            if (residence[node] !== env.get('NODE_NAME')) {

                                                let id = uuidv1();
                                                process.send({
                                                    "type": "clustering_payload", "pid": process.pid,
                                                    "clustering_type": "send",
                                                    "id": id,
                                                    "body": req.body,
                                                    "node": {"name": residence[node]}
                                                });
                                            }
                                        }
                                    }
                                });
                            } else {
                                for (let node in residence) {
                                    if (residence[node] !== env.get('NODE_NAME')) {
                                        log.debug(`Got a message for a table with a remote residence ${residence[node]}.  Broadcasting to cluster`);
                                        let id = uuidv1();
                                        global.clusterMsgQueue[id] = res;

                                        try {
                                            process.send({
                                                "type": "clustering_payload", "pid": process.pid,
                                                "clustering_type": "send",
                                                "id": id,
                                                "body": req.body,
                                                "node": {"name": residence[node]}
                                            });

                                        } catch (err) {
                                            log.error(err);
                                            return res.status(hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send({error: err.message});
                                        }
                                    }
                                }
                                // We need to manually set and send the status here, as processLocal isn't called.
                                return res.status(hdb_terms.HTTP_STATUS_CODES.OK).send({message: `Specified table has residence on node(s): ${residence.join()}; broadcasting message to cluster.`});
                            }
                        }
                    } else {
                        server_utilities.processLocalTransaction(req, res, operation_function, function () {
                            //no-op
                        });
                    }
                });
            }
        } else if (req.body.schema && req.body.table
            && req.body.operation !== 'create_table' && req.body.operation !== 'drop_table' && !hdb_terms.LOCAL_HARPERDB_OPERATIONS.includes(req.body.operation)) {

            global_schema.getTableSchema(req.body.schema, req.body.table, function (err, table) {

                if (!table || !table.residence || table.residence.indexOf(env.get('NODE_NAME')) > -1) {
                    server_utilities.processLocalTransaction(req, res, operation_function, function () {
                    });
                } else {
                    try {
                        async.forEach(table.residence, function (residence, callback_) {
                            let id = uuidv1();
                            let item = {
                                "payload": {"body": req.body, "id": id},
                                "id": id,
                                "node": {"node": residence},
                                "node_name": residence,
                                "timestamp": moment.utc().valueOf()
                            };

                            let insert_object = {
                                operation: 'insert',
                                schema: 'system',
                                table: 'hdb_queue',
                                records: [item]
                            };

                            insert.insertCB(insert_object, function (err) {
                                if (err) {
                                    log.error(err);
                                    return callback_(err);
                                }
                                return callback_();
                            });
                        }, function (err) {
                            if (err) {
                                return res.status(hdb_terms.HTTP_STATUS_CODES.NOT_IMPLEMENTED).send(err);
                            }
                            return res.status(hdb_terms.HTTP_STATUS_CODES.CREATED).send('{"message":"clustering is down. request has been queued and will be processed when clustering reestablishes.  "}');
                        });
                    } catch (e) {
                        log.error(e);
                    }
                }
            });
        } else {
            server_utilities.processLocalTransaction(req, res, operation_function, function () {
            });
        }
    } catch(err) {
        log.error(err);
        if (err === server_utilities.UNAUTH_RESPONSE) {
            return res.status(hdb_terms.HTTP_STATUS_CODES.FORBIDDEN).send({error: server_utilities.UNAUTHORIZED_TEXT});
        }
        if (typeof err === 'string') {
            return res.status(hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send({error: err});
        }
        return res.status(hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send(err);
    }
}

module.exports = {
    init: init
};
