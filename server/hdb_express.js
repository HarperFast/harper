const cluster = require('cluster');
let numCPUs = 4;
const DEBUG = false;
const winston = require('../utility/logging/winston_logger');
const search = require('../data_layer/search');

const async = require('async');

if (cluster.isMaster && !DEBUG) {
    let enterprise = false;
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
                messageHandler({"type":"enterprise", "enterprise": enterprise});

                cluster.on('exit', (worker, code, signal) => {
                    winston.info(`worker ${worker.process.pid} died`);
                });

                function messageHandler(msg) {
                    forks.forEach((fork) => {
                        fork.send(msg);
                    });
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
        ClusterServer = require('./clustering/cluster_server')
    clone = require('clone');

    cors = require('cors');

    hdb_properties.append(hdb_properties.get('settings_path'));
    global.cluster_server = null;
    let enterprise = false;
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
        if(req.headers.harperdb_connection && !enterprise){
            return res.status(401).json({"error":"This feature requires an enterprise license.  Please contact us at hello@harperdb.io for more info."});
        }

        auth.authorize(req, res, function (err, user) {
            res.set('x-powered-by', 'HarperDB');

            if (err) {
                winston.warn(`{"ip":"${req.connection.remoteAddress}", "error":"${err}"`);
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

                function broadCast() {

                    var operation = clone(req.body.operation);
                    server_utilities.processLocalTransaction(req, res, operation_function, function (err, data) {
                        if (!err) {
                            for (let o_node in global.cluster_server.socket_server.other_nodes) {
                                let payload = {};
                                payload.msg = req.body
                                if (data.id) {
                                    payload.msg.id = data.id;

                                }

                                if (!req.body.operation) {
                                    payload.msg.operation = operation;
                                }


                                payload.node = global.cluster_server.socket_server.other_nodes[o_node];
                                global.cluster_server.send(payload, res);
                            }

                        }

                    });


                }


                //TODO read log? describe_all etc...

                if (global.cluster_server && global.cluster_server.socket_server.name && req.body.operation != 'sql ') {
                    if (!req.body.schema
                        || !req.body.table
                        || req.body.operation === 'create_table'
                        || req.body.operation === 'drop_table'

                    ) {
                        var localOnlyOperations = ['describe_all', 'describe_table', 'describe_schema', 'read_log']
                        if (localOnlyOperations.includes(req.body.operation)) {
                            server_utilities.processLocalTransaction(req, res, operation_function, function (err) {
                                winston.error(err);
                            })
                        } else {
                            return broadCast();
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
                                    return broadCast();
                                }

                                if (residence.indexOf(hdb_properties.get('NODE_NAME')) > -1) {
                                    server_utilities.processLocalTransaction(req, res, operation_function, function () {
                                        if (residence.length > 1) {
                                            for (node in residence) {
                                                if (residence[node] != hdb_properties.get('NODE_NAME')) {
                                                    let payload = {};
                                                    payload.msg = req.body;
                                                    payload.node = payload.node = {"name": residence[node]};
                                                    global.cluster_server.send(payload, res);
                                                }
                                            }
                                        }

                                        for (let o_node in global.cluster_server.socket_server.other_nodes) {

                                        }
                                    });
                                } else {
                                    for (node in residence) {
                                        if (residence[node] != hdb_properties.get('NODE_NAME')) {
                                            let payload = {};
                                            payload.msg = req.body;
                                            payload.node = payload.node = {"name": residence[node]};
                                            global.cluster_server.send(payload, res);
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
                kickOffEnterprise();
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

                global_schema.setSchemaDataToGlobal((err, data) => {
                    if (err) {
                        winston.info('error', err);
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


        function kickOffEnterprise(){
            if (hdb_properties.get('CLUSTERING') && enterprise) {
                var node = {
                    "name": hdb_properties.get('NODE_NAME'),
                    "port": hdb_properties.get('CLUSTERING_PORT'),

                }

                global.cluster_server = new ClusterServer(node);


                let search_obj = {
                    "table": "hdb_nodes",
                    "schema": "system",
                    "search_attribute": "host",
                    "hash_attribute": "name",
                    "search_value": "*",
                    "get_attributes": ["*"]
                }
                search.searchByValue(search_obj, function (err, nodes) {
                    if (err) {
                        winston.error(err);
                    }

                    if (nodes) {
                        node.other_nodes = nodes;
                        global.cluster_server.init(function (err) {
                            if (err) {
                                return winston.error(err);
                            }
                            global.cluster_server.establishConnections(function (err) {
                                if (err) {
                                    return winston.error(err);
                                }

                                winston.info('clustering established');

                            })

                        });

                    }

                });


            }

        }



    } catch (e) {
        winston.error(e);
    }
}

