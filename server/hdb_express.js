const cluster = require('cluster');
const DEBUG = false;
const harper_logger = require('../utility/logging/harper_logger');
// We want to kick off the mgr initSync as soon as possible.
const env = require('../utility/environment/environmentManager');
try {
    env.initSync();
} catch(err) {
    harper_logger.error(`Got an error loading the environment.  Exiting.${err}`);
    process.exit(0);
}
const uuidv1 = require('uuid/v1');
const user_schema = require('../utility/user_schema');
const async = require('async');
const insert = require('../data_layer/insert');
const os = require('os');
const job_runner = require('./jobRunner');
const hdb_util = require('../utility/common_utils');
const guidePath = require('path');
const hdb_terms = require('../utility/hdbTerms');
const global_schema = require('../utility/globalSchema');
const fs = require('fs');
const cluster_utilities = require('./clustering/clusterUtilities');
const cluster_event = require('../events/ClusterStatusEmitter');
const signalling = require('../utility/signalling');
const moment = require('moment');

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
const PROPS_ENV_KEY = 'NODE_ENV';
const ENV_PROD_VAL = 'production';
const ENV_DEV_VAL = 'development';
const TRUE_COMPARE_VAL = 'TRUE';

let node_env_value = env.get(PROPS_ENV_KEY);

// If NODE_ENV is empty, it will show up here as '0' rather than '' or length of 0.
if (node_env_value === undefined || node_env_value === null || node_env_value === 0) {
    node_env_value = ENV_PROD_VAL;
} else if (node_env_value !== ENV_PROD_VAL || node_env_value !== ENV_DEV_VAL) {
    node_env_value = ENV_PROD_VAL;
}

process.env['NODE_ENV'] = node_env_value;

let num_hdb_processes = undefined;
let numCPUs = 4;
let num_workers = undefined;
let os_cpus = undefined;

//in an instance of having HDB installed on an android devices we don't have access to the cpu info so we need to handle the error and move on
try {
    num_hdb_processes = env.get(hdb_terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES);
    os_cpus = os.cpus().length;
    num_workers = ((num_hdb_processes && num_hdb_processes > 0) ? num_hdb_processes: os_cpus);
    // don't allow more processes than the machine has cores.
    if(num_workers > os_cpus) {
        num_workers = os_cpus;
        harper_logger.info(`${hdb_terms.HDB_SETTINGS_NAMES.MAX_HDB_PROCESSES} setting is higher than the number of cores on this machine (${os_cpus}).  Settings number of processes to ${os_cpus}`);
    }
} catch(e){
    num_workers = hdb_terms.HDB_SETTINGS_DEFAULT_VALUES.MAX_HDB_PROCESSES;
    if(num_hdb_processes) {
        num_workers = num_hdb_processes;
    }
    harper_logger.info(e);
}

if(DEBUG){
    numCPUs = 1;
}

cluster.on('exit', (dead_worker, code, signal) => {
    harper_logger.info(`worker ${dead_worker.process.pid} died with signal ${signal} and code ${code}`);
    let new_worker = undefined;
    try {
        new_worker = cluster.fork();
        new_worker.on('message', cluster_utilities.clusterMessageHandler);
        harper_logger.info(`kicked off replacement worker with new pid=${new_worker.process.pid}`);
    } catch (e) {
        harper_logger.fatal(`FATAL error trying to restart a dead_worker with pid ${dead_worker.process.pid}.  ${e}`);
        return;
    }
    for (let a_fork in global.forks) {
        if (global.forks[a_fork].process.pid === dead_worker.process.pid) {
            global.forks[a_fork] = new_worker;
            harper_logger.trace(`replaced dead fork in global.forks with new fork that has pid ${new_worker.process.pid}`);
        }
    }
});

if (cluster.isMaster &&( numCPUs >= 1 || DEBUG )) {
    global.isMaster = cluster.isMaster;
    const search = require('../data_layer/search');
    const enterprise_util = require('../utility/enterpriseInitialization');

    process.on('uncaughtException', function (err) {
        let os = require('os');
        let message = `Found an uncaught exception with message: os.EOL ${err.message}.  Stack: ${err.stack} ${os.EOL} Terminating HDB.`;
        console.error(message);
        harper_logger.fatal(message);

        process.exit(1);
    });

    let enterprise = false;
    global.delegate_callback_queue = [];
    let licenseKeySearch = {
        operation: 'search_by_value',
        schema: 'system',
        table: 'hdb_license',
        hash_attribute: 'license_key',
        search_attribute: "license_key",
        search_value: "*",
        get_attributes: ["*"]
    };
    global_schema.setSchemaDataToGlobal((err, data)=> {
        search.searchByValue(licenseKeySearch, function (err, licenses) {
            const hdb_license = require('../utility/registration/hdb_license');
            if (err) {
                return harper_logger.error(err);
            }

            Promise.all(licenses.map(async (license) => {
                try {
                    let license_validation = await hdb_license.validateLicense(license.license_key, license.company);
                    if (license_validation.valid_machine && license_validation.valid_date && license_validation.valid_license) {
                        enterprise = true;
                        cluster_utilities.setEnterprise(true);
                        if (num_workers > numCPUs) {
                            if (numCPUs === 4) {
                                numCPUs = 16;
                            } else {
                                numCPUs += 16;
                            }
                        }
                    }
                } catch(e){
                    harper_logger.error(e);
                }
            })).then(() => {
                harper_logger.info(`Master ${process.pid} is running`);
                harper_logger.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
                harper_logger.info(`Number of processes allowed by license is:${numCPUs}, number of cores on this machine: ${num_workers}`);
                numCPUs = (numCPUs > num_workers ? num_workers : numCPUs);
                harper_logger.info(`Kicking off ${numCPUs} HDB processes.`);

                // Fork workers.
                let forks = [];
                for (let i = 0; i < numCPUs; i++) {
                    try {
                        let forked = cluster.fork();
                        // assign handler for messages expected from child processes.
                        forked.on('message', cluster_utilities.clusterMessageHandler);
                        forks.push(forked);
                    } catch (e) {
                        harper_logger.fatal(`Had trouble kicking off new HDB processes.  ${e}`);
                    }
                }

                global.forks = forks;
                global.forkClusterMsgQueue = {};
            });
        });
    });
} else {
    harper_logger.info('In express' + process.cwd());
    harper_logger.info(`Running with NODE_ENV set as: ${process.env.NODE_ENV}`);
    const express = require('express');
    const bodyParser = require('body-parser');
    const auth = require('../security/auth');
    const passport = require('passport');
    const pjson = require('../package.json');
    const server_utilities = require('./serverUtilities');
    const cors = require('cors');

    const app = express();
    global.clusterMsgQueue = [];
    let enterprise = false;
    global.clustering_on = false;
    let props_cors = env.get(PROPS_CORS_KEY);
    let props_cors_whitelist = env.get(PROPS_CORS_WHITELIST_KEY);

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
            next();
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
                harper_logger.warn(`{"ip":"${req.connection.remoteAddress}", "error":"${err.stack}"`);
                if (typeof err === 'string') {
                    return res.status(hdb_terms.HTTP_STATUS_CODES.UNAUTHORIZED).send({error: err});
                }
                return res.status(hdb_terms.HTTP_STATUS_CODES.UNAUTHORIZED).send(err);
            }
            req.body.hdb_user = user;
            req.body.hdb_auth_header = req.headers.authorization;

            server_utilities.chooseOperation(req.body, (err, operation_function) => {
                if (err) {
                    harper_logger.error(err);
                    if(err === server_utilities.UNAUTH_RESPONSE) {
                        return res.status(hdb_terms.HTTP_STATUS_CODES.FORBIDDEN).send({error: server_utilities.UNAUTHORIZED_TEXT});
                    }
                    if (typeof err === 'string') {
                        return res.status(hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send({error: err});
                    }
                    return res.status(hdb_terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR).send(err);
                }
                let localOnlyOperations = ['describe_all', 'describe_table', 'describe_schema', 'read_log', 'add_node'];

                if (global.clustering_on && req.body.operation !== 'sql') {
                    if (!req.body.schema
                        || !req.body.table
                        || req.body.operation === 'create_table'
                        || req.body.operation === 'drop_table'
                        || req.body.operation === 'delete_files_before'
                    ) {
                        if (hdb_terms.LOCAL_HARPERDB_OPERATIONS.includes(req.body.operation)) {
                            harper_logger.info('local only operation: ' + req.body.operation);
                            server_utilities.processLocalTransaction(req, res, operation_function, function (err) {
                                if(err){
                                    harper_logger.error(err);
                                }
                            });
                        } else {
                            harper_logger.info('local & delegated operation: ' + req.body.operation);
                            server_utilities.processLocalTransaction(req, res, operation_function, function (err) {
                                if(err){
                                    harper_logger.error('error from local & delegated: ' + JSON.stringify(err));
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
                                harper_logger.error(err);
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
                                                harper_logger.debug(`Got a message for a table with a remote residence ${residence[node]}.  Broadcasting to cluster`);
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
                                                    harper_logger.error(err);
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
                                            harper_logger.error(err);
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
                                harper_logger.error(e);
                            }
                        }
                    });
                }else{
                    server_utilities.processLocalTransaction(req, res, operation_function, function () {
                    });
                }
            });
        });
    });

    process.on('message', (msg) => {
        switch (msg.type) {
            case 'schema':
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
                    harper_logger.info(`completed job with result ${result}`);
                }).catch(function isError(e) {
                    harper_logger.error(e);
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
                    harper_logger.error(err);
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
                harper_logger.info('Got cluster status message via IPC');
                cluster_event.clusterEmitter.emit(cluster_event.EVENT_NAME, msg.status);
                break;
            default:
                harper_logger.error(`Received unknown signaling message ${msg.type}, ignoring message`);
                break;
        }
    });

    process.on('uncaughtException', function (err) {
        let os = require('os');
        let message = `Found an uncaught exception with message: os.EOL ${err.message}.  Stack: ${err.stack} ${os.EOL} Terminating HDB.`;
        console.error(message);
        harper_logger.fatal(message);
        process.exit(1);
    });

    try {
        const http = require('http');
        const httpsecure = require('https');

        const privateKey = env.get(PROPS_PRIVATE_KEY);
        const certificate = env.get(PROPS_CERT_KEY);
        const credentials = {key: fs.readFileSync(`${privateKey}`), cert: fs.readFileSync(`${certificate}`)};
        const server_timeout = env.get(PROPS_SERVER_TIMEOUT_KEY);
        const props_http_secure_on = env.get(PROPS_HTTP_SECURE_ON_KEY);
        const props_http_on = env.get(PROPS_HTTP_ON_KEY);

        global.isMaster = cluster.isMaster;

        let httpServer = undefined;
        let secureServer = undefined;

        if (props_http_secure_on &&
            (props_http_secure_on === true || props_http_secure_on.toUpperCase() === TRUE_COMPARE_VAL)) {
            secureServer = httpsecure.createServer(credentials, app);
            secureServer.setTimeout(server_timeout ? server_timeout : DEFAULT_SERVER_TIMEOUT);
            secureServer.listen(env.get(PROPS_HTTP_SECURE_PORT_KEY), function () {
                harper_logger.info(`HarperDB ${pjson.version} HTTPS Server running on ${env.get(PROPS_HTTP_SECURE_PORT_KEY)}`);
                async.parallel(
                    [
                        global_schema.setSchemaDataToGlobal,
                        user_schema.setUsersToGlobal,
                        signalling.signalChildStarted
                    ], (error) => {
                        if (error) {
                            harper_logger.error(error);
                        }
                    });
            });
        }

        if (props_http_on &&
            (props_http_on === true || props_http_on.toUpperCase() === TRUE_COMPARE_VAL)) {
            httpServer = http.createServer(app);
            httpServer.setTimeout(server_timeout ? server_timeout : DEFAULT_SERVER_TIMEOUT);
            httpServer.listen(env.get(PROPS_HTTP_PORT_KEY), function () {
                harper_logger.info(`HarperDB ${pjson.version} HTTP Server running on ${env.get(PROPS_HTTP_PORT_KEY)}`);
                async.parallel(
                    [
                        global_schema.setSchemaDataToGlobal,
                        user_schema.setUsersToGlobal,
                        signalling.signalChildStarted
                    ], (error) => {
                        if (error) {
                            harper_logger.error(error);
                        }
                    });
            });
        }
    } catch (e) {
        harper_logger.error(e);
    }
}
