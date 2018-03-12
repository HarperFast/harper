const cluster = require('cluster');
const DEBUG = false;
const winston = require('../utility/logging/winston_logger');
const uuidv1 = require('uuid/v1');
const user_schema = require('../utility/user_schema');
const async = require('async');

const DEFAULT_SERVER_TIMEOUT = 120000;
const UNAUTH_ERROR_MESSAGE = "You are not authorized to perform this action.";
const PROPS_SERVER_TIMEOUT_KEY = 'SERVER_TIMEOUT_MS',
    PROPS_PRIVATE_KEY = 'PRIVATE_KEY',
    PROPS_CERT_KEY = 'CERTIFICATE',
    PROPS_HTTP_ON_KEY = 'HTTP_ON',
    PROPS_HTTP_SECURE_ON_KEY = 'HTTPS_ON',
    PROPS_HTTP_PORT_KEY = 'HTTP_PORT',
    PROPS_HTTP_SECURE_PORT_KEY = 'HTTPS_PORT',
    PROPS_CORS_KEY = 'CORS_ON',
    PROPS_CORS_WHITELIST_KEY = 'CORS_WHITELIST',
    PROPS_ENV_KEY = 'NODE_ENV',
    ENV_PROD_VAL = 'production',
    ENV_DEV_VAL = 'development',
    TRUE_COMPARE_VAL = 'TRUE';

PropertiesReader = require('properties-reader');
hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));

let node_env_value = hdb_properties.get(PROPS_ENV_KEY);

// If NODE_ENV is empty, it will show up here as '0' rather than '' or length of 0.
if (node_env_value === undefined || node_env_value === null || node_env_value === 0) {
    node_env_value = ENV_PROD_VAL;
} else if (node_env_value !== ENV_PROD_VAL || node_env_value !== ENV_DEV_VAL) {
    node_env_value = ENV_PROD_VAL;
}

process.env['NODE_ENV'] = node_env_value;

let numCPUs = 1;

let num_workers = require('os').cpus().length;
numCPUs = num_workers < numCPUs ? num_workers : numCPUs;

if(DEBUG){
    numCPUs = 1;
}

if (cluster.isMaster &&( numCPUs > 1 || DEBUG )) {
    const search = require('../data_layer/search');
    const cluster_utilities = require('./clustering/cluster_utilities');
    const enterprise_util = require('../utility/enterprise_initialization');
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

    search.searchByValue(licenseKeySearch, function (err, licenses) {
        const hdb_license = require('../utility/hdb_license');
        if (err) {
            return winston.error(err);
        }

        async.each(licenses, function (license, callback) {
            hdb_license.validateLicense(license.license_key, license.company, function (err, license_validation) {
                if (license_validation.valid_machine && license_validation.valid_date && license_validation.valid_license) {
                    enterprise = true;
                    if (num_workers > numCPUs) {
                        if (numCPUs === 4) {
                            numCPUs = 16;
                        } else {
                            numCPUs += 16;
                        }
                    }

                }
                callback();
            });
        }, function (err) {

            if (err)
                return winston.error(err);
            winston.info(`Master ${process.pid} is running`);
            winston.info(`Running with NODE_ENV as: ${process.env.NODE_ENV}`);
            // Fork workers.
            let forks = [];
            for (let i = 0; i < numCPUs; i++) {
                let forked = cluster.fork();
                forked.on('message', messageHandler);
                forks.push(forked);
            }

            global.forks = forks;
            if (enterprise) {
                messageHandler({"type": "enterprise", "enterprise": enterprise});
                enterprise_util.kickOffEnterprise(function (enterprise_msg) {
                    if (enterprise_msg.clustering) {
                        global.clustering_on = true;
                        messageHandler({"type": "clustering"});
                    }
                });
            }

            cluster.on('exit', (worker, code, signal) => {
                winston.info(`worker ${worker.process.pid} died`);
            });

            global.forkClusterMsgQueue = [];

            function messageHandler(msg) {
                try {
                    if (msg.type === 'clustering_payload') {
                        forkClusterMsgQueue[msg.id] = msg;
                        cluster_utilities.payloadHandler(msg);
                    } else if (msg.type === 'delegate_thread_response') {
                        global.delegate_callback_queue[msg.id](msg.err, msg.data);
                    } else {
                        forks.forEach((fork) => {
                            fork.send(msg);
                        });
                    }
                }catch(e){
                    winston.error(e);

                }
            }
        });
    });
} else {


    winston.info('In express' + process.cwd());
    winston.info(`Running with NODE_ENV as: ${process.env.NODE_ENV}`);
    const express = require('express'),
        app = express(),
        bodyParser = require('body-parser'),

        auth = require('../security/auth'),
        passport = require('passport'),
        global_schema = require('../utility/globalSchema'),
        pjson = require('../package.json'),
        server_utilities = require('./server_utilities'),
        clone = require('clone');

    cors = require('cors');

    hdb_properties.append(hdb_properties.get('settings_path'));
    global.clusterMsgQueue = [];
    let enterprise = false;
    global.clustering_on = false;
    let props_cors = hdb_properties.get(PROPS_CORS_KEY);
    let props_cors_whitelist = hdb_properties.get(PROPS_CORS_WHITELIST_KEY);

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
                    callback(null, true);
                } else {
                    callback(new Error(`domain ${origin} is not whitelisted`));
                }
            };
        }
        app.use(cors(cors_options));
    }

    app.use(bodyParser.json({limit: '1gb'})); // support json encoded bodies
    app.use(bodyParser.urlencoded({extended: true}));
    app.use(function (error, req, res, next) {
        if (error instanceof SyntaxError) {
            res.status(400).send({error: 'invalid JSON: ' + error.message.replace('\n', '')});
        } else if (error) {
            res.status(400).send({error: error.message});
        } else {
            next();
        }
    });

    app.use(passport.initialize());
    app.get('/', function (req, res) {
        auth.authorize(req, res, function (err, user) {
            let guidePath = require('path');
            res.sendFile(guidePath.resolve('../docs/user_guide.html'));
        });
    });

    app.post('/', function (req, res) {

        let enterprise_operations = ['add_node'];
        if ((req.headers.harperdb_connection || enterprise_operations.indexOf(req.body.operation) > -1) && !enterprise) {
            return res.status(401).json({"error": "This feature requires an enterprise license.  Please register or contact us at hello@harperdb.io for more info."});
        }

        auth.authorize(req, res, function (err, user) {
            res.set('x-powered-by', 'HarperDB');

            if (err) {
                winston.warn(`{"ip":"${req.connection.remoteAddress}", "error":"${err.stack}"`);
                if (typeof err === 'string') {
                    return res.status(401).send({error: err});
                }
                return res.status(401).send(err);
            }
            req.body.hdb_user = user;
            req.body.hdb_auth_header  = req.headers.authorization;



            server_utilities.chooseOperation(req.body, (err, operation_function) => {
                if (err) {
                    winston.error(err);
                    if(err === server_utilities.UNAUTH_RESPONSE) {
                        return res.status(403).send({error: server_utilities.UNAUTHORIZED_TEXT});
                    } else {
                        if (typeof err === 'string') {
                            return res.status(500).send({error: err});
                        }
                        return res.status(500).send(err);
                    }
                }
                if (global.clustering_on && req.body.operation != 'sql') {
                    if (!req.body.schema
                        || !req.body.table
                        || req.body.operation === 'create_table'
                        || req.body.operation === 'drop_table'

                    ) {
                        var localOnlyOperations = ['describe_all', 'describe_table', 'describe_schema', 'read_log']
                        if (localOnlyOperations.includes(req.body.operation)) {
                            server_utilities.processLocalTransaction(req, res, operation_function, function (err) {
                                winston.error(err);
                            });
                        } else {
                            server_utilities.processLocalTransaction(req, res, operation_function, function (err) {
                                if (!err) {
                                    let id = uuidv1();
                                    //  global.clusterMsgQueue[id] = res;
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
                                winston.error(err);
                                return res.status(500).send(err);
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
                                            //  global.clusterMsgQueue[id] = res;
                                            process.send({
                                                "type": "clustering_payload", "pid": process.pid,
                                                "clustering_type": "broadcast",
                                                "id": id,
                                                "body": req.body
                                            });
                                        }
                                    });
                                }

                                if (residence.indexOf(hdb_properties.get('NODE_NAME')) > -1) {
                                    server_utilities.processLocalTransaction(req, res, operation_function, function () {
                                        if (residence.length > 1) {
                                            for (node in residence) {
                                                if (residence[node] != hdb_properties.get('NODE_NAME')) {

                                                    let id = uuidv1();
                                                    // global.clusterMsgQueue[id] = res;
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
                                    for (node in residence) {
                                        if (residence[node] != hdb_properties.get('NODE_NAME')) {
                                            let id = uuidv1();
                                            global.clusterMsgQueue[id] = res;
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
                            } else {
                                server_utilities.processLocalTransaction(req, res, operation_function, function () {
                                    //no-op
                                });
                            }
                        });
                    }
                } else {
                    server_utilities.processLocalTransaction(req, res, operation_function, function () {
                        // no-op
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
                        winston.error(err);
                    }
                });
                break;
            case 'user':
                user_schema.setUsersToGlobal((err) => {
                    if (err) {
                        winston.error(err);
                    }
                });
                break;
            case 'enterprise':
                enterprise = msg.enterprise;
                break;
            case 'clustering':
                global.clustering_on = true;
                break;
            case 'cluster_response':
                if (global.clusterMsgQueue[msg.id]) {
                    if (msg.err) {
                        global.clusterMsgQueue[msg.id].status(401).json({"error": msg.err});
                        delete global.clusterMsgQueue[msg.id];
                        break;
                    }

                    global.clusterMsgQueue[msg.id].status(200).json(msg.data);
                    delete global.clusterMsgQueue[msg.id];
                }
                break;
            case 'delegate_transaction':
                server_utilities.chooseOperation(msg.body, function (err, operation_function) {
                    server_utilities.processInThread(msg.body, operation_function, function (err, data) {
                        process.send({"type": "delegate_thread_response", "err": err, "data": data, "id": msg.id});
                    });
                });
                break;
        }
    });

    try {
        let http = require('http');
        let httpsecure = require('https');
        let privateKey = hdb_properties.get(PROPS_PRIVATE_KEY);
        let certificate = hdb_properties.get(PROPS_CERT_KEY);
        let credentials = {key: privateKey, cert: certificate};
        let server_timeout = hdb_properties.get(PROPS_SERVER_TIMEOUT_KEY);
        let props_http_secure_on = hdb_properties.get(PROPS_HTTP_SECURE_ON_KEY);
        let props_http_on = hdb_properties.get(PROPS_HTTP_ON_KEY);
        let httpServer = undefined;
        let secureServer = undefined;

        if (props_http_secure_on &&
            (props_http_secure_on === true || props_http_secure_on.toUpperCase() === TRUE_COMPARE_VAL)) {
            secureServer = httpsecure.createServer(credentials, app);
            secureServer.setTimeout(server_timeout ? server_timeout : DEFAULT_SERVER_TIMEOUT);
            secureServer.listen(hdb_properties.get(PROPS_HTTP_SECURE_PORT_KEY), function () {
                winston.info(`HarperDB ${pjson.version} HTTPS Server running on ${hdb_properties.get(PROPS_HTTP_SECURE_PORT_KEY)}`);
                async.parallel(
                    [
                        global_schema.setSchemaDataToGlobal,
                        user_schema.setUsersToGlobal
                    ], (error, data) => {
                        if (error) {
                            winston.error(error);
                        }
                    });
            });
        }

        if (props_http_on &&
            (props_http_on === true || props_http_on.toUpperCase() === TRUE_COMPARE_VAL)) {
            httpServer = http.createServer(app);
            httpServer.setTimeout(server_timeout ? server_timeout : DEFAULT_SERVER_TIMEOUT);
            httpServer.listen(hdb_properties.get(PROPS_HTTP_PORT_KEY), function () {
                winston.info(`HarperDB ${pjson.version} HTTP Server running on ${hdb_properties.get(PROPS_HTTP_PORT_KEY)}`);
                async.parallel(
                    [
                        global_schema.setSchemaDataToGlobal,
                        user_schema.setUsersToGlobal
                    ], (error, data) => {
                        if (error) {
                            winston.error(error);
                        }
                    });
            });
        }
    } catch (e) {
        winston.error(e);
    }
}

