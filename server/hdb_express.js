const cluster = require('cluster');
const numCPUs = 4;
const DEBUG = true;
const winston = require('winston');
winston.configure({
    transports: [
        new (winston.transports.File)({filename: 'hdb.log'})
    ]
});


if (cluster.isMaster && !DEBUG) {
    console.log(`Master ${process.pid} is running`);

    // Fork workers.
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`worker ${worker.process.pid} died`);
    });
} else {
    winston.log('In express' + process.cwd());
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
        global_schema = require('../utility/globalSchema'),
        user = require('../security/user'),
        role = require('../security/role');

    hdb_properties.append(hdb_properties.get('settings_path'));


    app.use(bodyParser.json()); // support json encoded bodies
    app.use(bodyParser.urlencoded({extended: true}));
    app.use(session({ secret: 'keyboard cat' }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.post('/', function (req, res) {
        auth.authorize(req, res, function(err, user) {
            if(err){
                res.status(401).send(err);
                return;
            }

            chooseOperation(req.body, (err, operation_function) => {
                if (err) {
                    console.log(err);
                    res.status(500).send(err);
                    return;
                }

                try {
                    operation_function(req.body, (error, data) => {
                        if (error) {
                            console.log(error);
                            res.status(500).json(error);
                            return;
                        }

                        res.status(200).json(data);
                    });
                } catch (e) {
                    console.log(e);
                    res.status(500).json(e);
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
            case 'search_by_hashes':
                operation_function = search.searchByHashes;
                break;
            case 'search_by_value':
                operation_function = search.searchByValue;
                break;
            case 'search_by_join':
                operation_function = search.searchByJoin;
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
            case 'add_user':
                operation_function = user.addUser;
                break;
            case 'alter_user':
                operation_function = user.alterUser;
                break;
            case 'drop_user':
                operation_function = user.dropUser;
                break;
            case 'add_role':
                operation_function = role.addRole;
                break;
            case 'alter_role':
                operation_function = role.alterRole;
                break;
            case 'drop_role':
                operation_function = user.dropRole;
                break;

            default:
                break;
        }

        callback(null, operation_function);
    }

    function nullOperation(json, callback) {
        callback('Invalid operation');
    }

    app.listen(hdb_properties.get('HTTP_PORT'), function () {
        console.log(`HarperDB Server running on ${hdb_properties.get('HTTP_PORT')}`);

        global_schema.setSchemaDataToGlobal((err, data) => {
            if (err) {
                winston.log('error', err);
            }

        });
    });
}
