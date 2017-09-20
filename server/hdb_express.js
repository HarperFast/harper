const cluster = require('cluster');
const numCPUs = 1;
const DEBUG = false;
const winston = require('../utility/logging/winston_logger');


if (cluster.isMaster && !DEBUG) {
    winston.info(`Master ${process.pid} is running`);

    // Fork workers.
    let forks = [];
    for (let i = 0; i < numCPUs; i++) {
        let forked = cluster.fork();
        forked.on('message', messageHandler);
        forks.push(forked);
    }

    cluster.on('exit', (worker, code, signal) => {
        winston.info(`worker ${worker.process.pid} died`);
    });

    function messageHandler(msg) {
        forks.forEach((fork)=>{
            fork.send(msg);
        });
    }

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


    hdb_properties.append(hdb_properties.get('settings_path'));
    global.cluster_server = null;

    app.use(bodyParser.json()); // support json encoded bodies
    app.use(bodyParser.urlencoded({extended: true}));
    app.use(session({ secret: 'keyboard cat',     resave: true,
        saveUninitialized: true }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.post('/', function (req, res) {
        auth.authorize(req, res, function(err, user) {
            if(err){
                winston.warn(`{"ip":"${req.connection.remoteAddress}", "error":"${err}"`);
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

                function broadCast(){

                    var operation = clone(req.body.operation);
                    server_utilities.processLocalTransaction(req,res, operation_function, function(err, data){
                          if(!err){
                              for(let o_node in global.cluster_server.socket_server.other_nodes){
                                  let payload = {};
                                  payload.msg = req.body
                                  if(data.id){
                                      payload.msg.id = data.id;

                                  }

                                  if(!req.body.operation){
                                      payload.msg.operation = operation;
                                  }



                                  payload.node = global.cluster_server.socket_server.other_nodes[o_node];
                                  global.cluster_server.send(payload, res);
                              }

                          }

                    });


                }


                //TODO read log? describe_all etc...

                if(global.cluster_server && global.cluster_server.socket_server.name && req.body.operation != 'sql ') {
                    if(!req.body.schema
                        || !req.body.table
                        || req.body.operation === 'create_table'
                        || req.body.operation ==='drop_table'

                    ){
                        var localOnlyOperations = ['describe_all', 'describe_table', 'describe_schema', 'read_log']
                        if(localOnlyOperations.includes(req.body.operation)){
                            server_utilities.processLocalTransaction(req,res,operation_function, function(err){
                                winston.error(err);
                            })
                        }else{
                            return broadCast();
                        }

                    }else{
                        global_schema.getTableSchema(req.body.schema, req.body.table, function(err, table){
                            if(err){
                                winston.error(err);
                                return res.status(500).send(err);

                            }


                            if(table.residence){
                                let residence = table.residence;
                                if(typeof table.residence === 'string'){
                                    residence = JSON.parse(table.residence);
                                }

                                if(residence.indexOf('*') > -1){
                                    return broadCast();
                                }

                                if(residence.indexOf(hdb_properties.get('NODE_NAME')) > -1){
                                    server_utilities.processLocalTransaction(req, res, operation_function, function(){
                                        if(residence.length > 1){
                                            for(node in residence){
                                                if(residence[node] != hdb_properties.get('NODE_NAME')){
                                                    let payload = {};
                                                    payload.msg = req.body;
                                                    payload.node = payload.node = {"name":residence[node]};
                                                    global.cluster_server.send(payload, res);
                                                }
                                            }
                                        }

                                        for(let o_node in global.cluster_server.socket_server.other_nodes){

                                        }
                                    });
                                }else{
                                    for(node in residence){
                                        if(residence[node] != hdb_properties.get('NODE_NAME')){
                                            let payload = {};
                                            payload.msg = req.body;
                                            payload.node = payload.node = {"name":residence[node]};
                                            global.cluster_server.send(payload, res);
                                        }
                                    }
                                }


                            }else{
                                server_utilities.processLocalTransaction(req, res, operation_function, function(){

                                });
                            }





                        });


                    }


                }else{
                    server_utilities.processLocalTransaction(req, res, operation_function, function(){

                    });
                }







            });
        });

    });




    process.on('message', (msg)=>{
        global_schema.schemaSignal((err)=>{
            if(err){
                winston.error(err);
            }
        });
    });

    try{
        var http = require('http');
        var https = require('https');
        var privateKey  = fs.readFileSync(hdb_properties.get('PRIVATE_KEY'), 'utf8');
        var certificate = fs.readFileSync(hdb_properties.get('CERTIFICATE'), 'utf8');
        var credentials = {key: privateKey, cert: certificate};

// your express configuration here

        var httpServer = http.createServer(app);
        var httpsServer = https.createServer(credentials, app);

        //httpServer.listen(8080);

        if(hdb_properties.get('HTTPS_ON') && hdb_properties.get('HTTPS_ON').toUpperCase() === 'TRUE'){
            httpsServer.listen(hdb_properties.get('HTTPS_PORT'), function(){
                winston.info(`HarperDB ${pjson.version} HTTPS Server running on ${hdb_properties.get('HTTPS_PORT')}`);

                global_schema.setSchemaDataToGlobal((err, data) => {
                    if (err) {
                        winston.info('error', err);
                    }

                });



            });

        }

        // TODO move to run and drop CS into global

        if(hdb_properties.get('HTTP_ON') && hdb_properties.get('HTTP_ON').toUpperCase()  === 'TRUE'){
            httpServer.listen(hdb_properties.get('HTTP_PORT'), function(){
                winston.info(`HarperDB ${pjson.version} HTTP Server running on ${hdb_properties.get('HTTP_PORT')}`);

                global_schema.setSchemaDataToGlobal((err, data) => {
                    if (err) {
                        winston.info('error', err);
                    }

                });

            });
        }

        if(hdb_properties.get('CLUSTERING')){
            var node = {
                "name": hdb_properties.get('NODE_NAME'),
                "port": hdb_properties.get('CLUSTERING_PORT'),

            }

            const search = require('../data_layer/search');
            let search_obj = {
                "table":"hdb_nodes",
                "schema":"system",
                "search_attribute":"host",
                "hash_attribute" : "name",
                "search_value":"*",
                "get_attributes":["*"]
            }
            search.searchByValue(search_obj, function(err, nodes){
                if(err){
                    winston.error(err);
                }

                if(nodes){
                    node.other_nodes = nodes;
                    global.cluster_server = new ClusterServer(node);
                    global.cluster_server.init(function(err){
                        if(err){
                            return winston.error(err);
                        }
                        global.cluster_server.establishConnections(function(err){
                            if(err){
                                return winston.error(err);
                            }

                            winston.info('clustering established');

                        })

                    });

                }

            });







        }



    }catch(e){
        winston.error(e);
    }
}

