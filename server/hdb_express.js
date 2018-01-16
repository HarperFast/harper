const cluster = require('cluster');
let numCPUs = 1;
const DEBUG = false;
const winston = require('../utility/logging/winston_logger');
const search = require('../data_layer/search');
const cluster_utilities = require('./clustering/cluster_utilities');
const enterprise_util = require('../utility/enterprise_initialization');
const uuidv1 = require('uuid/v1');

const async = require('async');

if (cluster.isMaster && !DEBUG) {
    let enterprise = false;
    global.delegate_callback_queue = [];
    let licenseKeySearch = {
        operation: 'search_by_value',
        schema: 'system',
        table: 'hdb_license',
        hash_attribute: 'license_key',
        search_attribute: "license_key",
        search_value: "*",
        get_attributes:["*"]


    };

    search.searchByValue(licenseKeySearch, function (err, licenses) {
        const hdb_license = require('../utility/hdb_license');
        if (err) {
            return winston.error(err);
        }

            async.each(licenses, function(license, callback){
                hdb_license.validateLicense(license.license_key, license.company, function (err, license_validation) {
                    if (license_validation.valid_machine && license_validation.valid_date  && license_validation.valid_license){
                        enterprise = true;

                         if(numCPUs === 4){
                             numCPUs = 16;
                        }else{
                            numCPUs +=16;

                        }
                    }
                    callback();

                });
            }, function(err){

                if(err)
                    return winston.error(err);

                winston.info(`Master ${process.pid} is running`);

                // Fork workers.
                let forks = [];
                let num_workers = require('os').cpus().length;
                numCPUs = num_workers < numCPUs ? num_workers : numCPUs;
                for (let i = 0; i < numCPUs; i++) {
                    let forked = cluster.fork();
                    forked.on('message', messageHandler);
                    forks.push(forked);
                }

                global.forks = forks;


                if(enterprise){
                    messageHandler({"type":"enterprise", "enterprise":enterprise});
                    enterprise_util.kickOffEnterprise(function(enterprise_msg){
                        if(enterprise_msg.clustering){
                            messageHandler({"type":"clustering"});

                        }
                    });

                }




                cluster.on('exit', (worker, code, signal) => {
                    winston.info(`worker ${worker.process.pid} died`);
                });

                global.forkClusterMsgQueue = [];
                function messageHandler(msg) {
                    if(msg.type === 'clustering_payload'){
                        forkClusterMsgQueue[msg.id]  = msg;
                        cluster_utilities.payloadHandler(msg);
                    }else if(msg.type === 'delegate_thread_response'){
                        global.delegate_callback_queue[msg.id](msg.err, msg.data);
                    }else{
                        forks.forEach((fork) => {
                            fork.send(msg);
                        });
                    }




                }

            });







    });



} else {
    winston.info('In express' + process.cwd());
    const express = require('express'),
        PropertiesReader = require('properties-reader'),
        hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`),
        app = express(),
        bodyParser = require('body-parser'),

        auth = require('../security/auth'),
        session = require('express-session'),
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
    if (hdb_properties.get('CORS_ON') && (hdb_properties.get('CORS_ON') === true || hdb_properties.get('CORS_ON').toUpperCase() === 'TRUE')) {
        let cors_options = {
            origin: true,
            allowedHeaders: ['Content-Type', 'Authorization'],
            credentials: false
        };
        if (hdb_properties.get('CORS_WHITELIST') && hdb_properties.get('CORS_WHITELIST').length > 0) {
            let whitelist = hdb_properties.get('CORS_WHITELIST').split(',');
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

    app.use(session({
        secret: 'keyboard cat', resave: true,
        saveUninitialized: true
    }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.post('/', function (req, res) {

        let enterprise_operations = ['add_node'];
        if((req.headers.harperdb_connection || enterprise_operations.indexOf(req.body.operation) > -1) && !enterprise){
            return res.status(401).json({"error":"This feature requires an enterprise license.  Please register or contact us at hello@harperdb.io for more info."});
        }

        auth.authorize(req, res, function (err, user) {
            res.set('x-powered-by', 'HarperDB');

            if (err) {
                winston.warn(`{"ip":"${req.connection.remoteAddress}", "error":"${err.stack}"`);
                if (typeof err === 'string') {
                    return res.status(401).send({error: err});
                }
                res.status(401).send(err);
                return;
            }
            req.body.hdb_user = user;


            server_utilities.chooseOperation(req.body, (err, operation_function) => {

                if (err) {
                    winston.error(err);
                    res.status(500).send(err);
                    return;
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
                            server_utilities.processLocalTransaction(req, res, operation_function,function(err){
                                if(!err){
                                    let id = uuidv1();
                                  //  global.clusterMsgQueue[id] = res;
                                    process.send({"type":"clustering_payload", "pid":process.pid,
                                        "clustering_type":"broadcast",
                                        "id": id,
                                        "body":req.body
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

                                    server_utilities.processLocalTransaction(req, res, operation_function,function(err){
                                        if(!err){
                                            let id = uuidv1();
                                          //  global.clusterMsgQueue[id] = res;
                                            process.send({"type":"clustering_payload", "pid":process.pid,
                                                "clustering_type":"broadcast",
                                                "id": id,
                                                "body":req.body
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
                                                    process.send({"type":"clustering_payload", "pid":process.pid,
                                                        "clustering_type":"send",
                                                        "id": id,
                                                        "body":req.body,
                                                        "node":{"name":residence[node]}
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
                                            process.send({"type":"clustering_payload", "pid":process.pid,
                                                "clustering_type":"send",
                                                "id": id,
                                                "body":req.body,
                                                "node":{"name":residence[node]}
                                            });
                                        }
                                    }
                                }


                            } else {
                                server_utilities.processLocalTransaction(req, res, operation_function, function () {

                                });
                            }


                        });

                        app.get('/', function (req, res) {
                            auth.authorize(req, res, function (err, user) {
                                var guidePath = require('path');
                                res.sendFile(guidePath.resolve('../docs/user_guide.html'));
                            });
                        });

                    }


                } else {
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
                        winston.error(err);
                    }
                });
                break;
            case 'user':
                global_schema.setUsersToGlobal((err) => {
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
                if(global.clusterMsgQueue[msg.id]){
                    if(msg.err){
                        global.clusterMsgQueue[msg.id].status(401).json({"error":msg.err});
                        delete global.clusterMsgQueue[msg.id];
                        break;
                    }

                    global.clusterMsgQueue[msg.id].status(200).json(msg.data);
                    delete global.clusterMsgQueue[msg.id];
                }

                break;



            case 'delegate_transaction':
                server_utilities.chooseOperation(msg.body, function(err, operation_function){
                   server_utilities.processInThread(msg.body, operation_function,function(err, data){
                      process.send({"type":"delegate_thread_response", "err":err, "data": data, "id":msg.id});
                   });
                });
                break;
        }
    });

    try {
        let http = require('http');
        let httpsecure = require('https');
        let privateKey = fs.readFileSync(hdb_properties.get('PRIVATE_KEY'), 'utf8');
        let certificate = fs.readFileSync(hdb_properties.get('CERTIFICATE'), 'utf8');
        let credentials = {key: privateKey, cert: certificate};

        let httpServer = undefined;
        let secureServer = undefined;

        if (hdb_properties.get('HTTPS_ON') && (hdb_properties.get('HTTPS_ON') === true || hdb_properties.get('HTTPS_ON').toUpperCase() === 'TRUE')) {
            secureServer = httpsecure.createServer(credentials, app);
            secureServer.listen(hdb_properties.get('HTTPS_PORT'), function () {
                winston.info(`HarperDB ${pjson.version} HTTPS Server running on ${hdb_properties.get('HTTPS_PORT')}`);

                async.parallel(
                    [
                        global_schema.setSchemaDataToGlobal,
                        global_schema.setUsersToGlobal
                    ], (error, data) => {
                        if (error) {
                            winston.error(error);
                        }
                    });
            });
        }

        if (hdb_properties.get('HTTP_ON') && (hdb_properties.get('HTTP_ON') === true || hdb_properties.get('HTTP_ON').toUpperCase() === 'TRUE')) {
            httpServer = http.createServer(app);
            httpServer.listen(hdb_properties.get('HTTP_PORT'), function () {
                winston.info(`HarperDB ${pjson.version} HTTP Server running on ${hdb_properties.get('HTTP_PORT')}`);

                async.parallel(
                    [
                        global_schema.setSchemaDataToGlobal,
                        global_schema.setUsersToGlobal
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

