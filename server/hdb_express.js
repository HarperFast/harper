const cluster = require('cluster');
const numCPUs = 5;
const winston = require('winston');
winston.configure({
    transports: [
        new (winston.transports.File)({filename: 'hdb.log'})
    ]
});


if (cluster.isMaster) {
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
        write = require('../data_layer/insert').insert,
        search = require('../data_layer/search'),
        sql = require('../sqlTranslator/index').evaluateSQL,
        csv = require('../data_layer/csvBulkLoad');

       hdb_properties.append(hdb_properties.get('settings_path'));


        app.use(bodyParser.json()); // support json encoded bodies
    app.use(bodyParser.urlencoded({extended: true}));

    app.post('/', function (req, res) {
        chooseOperation(req.body, (err, operation_function) => {
            if (err) {
                console.log(err);
                res.status(500).send(err);
                return;
            }

            operation_function(req.body, (error, data) => {
                if (error) {
                    console.log(error);
                    res.status(500).send(err);
                    return;
                }

                res.status(200).send(data);
            });
        });

    });

    function chooseOperation(json, callback) {
        let operation_function = nullOperation;
        switch (json.operation) {
            case 'insert':
            case 'update':
                operation_function = write;
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
            case 'sql':
                operation_function = sql;
                break;
            case 'csv_data_load':
                operation_function = csv.csvDataLoad;
                break
            case 'csv_file_load':
                operation_function = csv.csvFileLoad;
                break;
            case 'csv_url_load':
                operation_function = csv.csvDataLoad;
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
        console.log(`Express server running on ${hdb_properties.get('HTTP_PORT')}`)
    });
}
