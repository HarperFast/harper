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
        cluster_server = require('./cluster_server')


    hdb_properties.append(hdb_properties.get('settings_path'));


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


            server_utilities.chooseOperation(req.body, (err, operation_function, delegate_operation) => {
                if (err) {
                    winston.error(err);
                    res.status(500).send(err);
                    return;
                }
                if(hdb_properties.get("CLUSTERING") && delegate_operation && hdb_properties.get("CLUSTERING_PORT") && hdb_properties.get("NODE_NAME")) {
                    global_schema.getTableSchema(req.body.schema, req.body.table, function(err, table){
                        if(err){
                            winston.error(err);
                            return res.status(500).send(err);

                        }

                        if(table.residence
                                && (table.residence.indexOf(hdb_properties.get('NODE_NAME')) > -1
                                || table.residence.indexOf('*') > -1)){

                            server_utilities.processLocalTransaction(req,res, operation_function, function(err){
                              if(!err && table.residence.length > 1){

                              }

                           });
                        }else if(table.residence){
                            cluster_server.proccess(req, table.residence);
                        }else{
                            server_utilities.processLocalTransaction(req, res, operation_function, function(){

                            });
                        }


                    });


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



    }catch(e){
        winston.error(e);
    }
}

