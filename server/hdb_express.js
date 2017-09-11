const cluster = require('cluster');
const numCPUs = 16;
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
        write = require('../data_layer/insert'),
        search = require('../data_layer/search'),
        sql = require('../sqlTranslator/index').evaluateSQL,
        csv = require('../data_layer/csvBulkLoad'),
        schema = require('../data_layer/schema'),
        delete_ = require('../data_layer/delete'),
        auth = require('../security/auth'),
        session = require('express-session'),
        passport = require('passport'),
        user = require('../security/user'),
        role = require('../security/role'),
        read_log = require('../utility/logging/read_logs'),
        global_schema = require('../utility/globalSchema'),
        pjson = require('../package.json'),
        async = require('async');


    hdb_properties.append(hdb_properties.get('settings_path'));


    app.use(bodyParser.json()); // support json encoded bodies
    app.use(bodyParser.urlencoded({extended: true}));

    app.use(function (error, req, res, next) {
        if (error instanceof SyntaxError) {
            res.status(400).send({error: 'invalid JSON: ' + error.message.replace('\n', '')});
        } else {
            next();
        }
    });

    app.use(session({ secret: 'keyboard cat',     resave: true,
        saveUninitialized: true }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.post('/', function (req, res) {
        auth.authorize(req, res, function(err, user) {
            res.set('x-powered-by', 'HarperDB');

            if(err){
                winston.warn(`{"ip":"${req.connection.remoteAddress}", "error":"${err}"`);
                res.status(401).send(err);
                return;
            }
            req.body.hdb_user = user;
            chooseOperation(req.body, (err, operation_function) => {
                if (err) {
                    winston.error(err);
                    res.status(500).send(err);
                    return;
                }

                try {
                    if(req.body.operation != 'read_log')
                        winston.info(JSON.stringify(req.body));

                    operation_function(req.body, (error, data) => {
                        if (error) {
                            winston.error(error);
                            if(typeof error != 'object')
                                error = {"error": error};
                            res.status(200).json(error);
                            return;
                        }
                        if(typeof data != 'object')
                            data = {"message": data};

                        return res.status(200).json(data);
                    });
                } catch (e) {
                    winston.error(e);
                    return res.status(500).json(e);
                }
            });
        });

    });


    function chooseOperation(json, callback) {
        let operation_function = nullOperation;
        switch (json.operation) {
            case 'insert':
                operation_function = write.insert;
                break;
            case 'update':
                operation_function = write.update;
                break;
            case 'search_by_hash':
                operation_function = search.searchByHash;
                break;
            case 'search_by_value':
                operation_function = search.searchByValue;
                break;
            case 'search':
                operation_function = search.search;
                break;
            case 'sql':
                operation_function = sql;
                break;
            case 'csv_data_load':
                operation_function = csv.csvDataLoad;
                break;
            case 'csv_file_load':
                operation_function = csv.csvFileLoad;
                break;
            case 'csv_url_load':
                operation_function = csv.csvURLLoad;
                break;
            case 'create_schema':
                operation_function = schema.createSchema;
                break;
            case 'create_table':
                operation_function = schema.createTable;
                break;
            case 'drop_schema':
                operation_function = schema.dropSchema;
                break;
            case 'drop_table':
                operation_function = schema.dropTable;
                break;
            case 'describe_schema':
                operation_function = schema.describeSchema;
                break;
            case 'describe_table':
                operation_function = schema.describeTable;
                break;
            case 'describe_all':
                operation_function = schema.describeAll;
                break;
            case 'delete':
                operation_function = delete_.delete;
                break;
            case 'add_user':
                operation_function = user.addUser;
                break;
            case 'alter_user':
                operation_function = user.alterUser;
                break;
            case 'drop_user':
                operation_function = user.dropUser;
                break;
            case 'list_users':
                operation_function = user.listUsers;
                break;
            case 'list_roles':
                operation_function = role.listRoles;
                break;
            case 'add_role':
                operation_function = role.addRole;
                break;
            case 'alter_role':
                operation_function = role.alterRole;
                break;
            case 'drop_role':
                operation_function = role.dropRole;
                break;
            case 'user_info':
                operation_function = user.userInfo
                break;
            case 'read_log':
                operation_function = read_log.read_log;

            default:
                break;
        }

        callback(null, operation_function);
    }

    function nullOperation(json, callback) {
        callback('Invalid operation');
    }

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

                async.parallel(
                    [
                        global_schema.setSchemaDataToGlobal,
                        global_schema.setUsersToGlobal
                    ], (error, data)=>{
                        if(error){
                            winston.error(error);
                        }
                    });


            });
        }



    }catch(e){

        winston.error(e);
    }
}

