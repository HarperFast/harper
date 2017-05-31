const cluster = require('cluster');
const numCPUs = 5;

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
    const express = require('express'),
        boot_loader = require('../utility/hdb_boot_loader')
        settings =require(boot_loader.settings()),
        app = express(),
        bodyParser = require('body-parser'),
        write = require('../data_layer/insert').insert,
        search = require('../data_layer/search');


    app.use(bodyParser.json()); // support json encoded bodies
    app.use(bodyParser.urlencoded({extended: true}));

    app.post('/', function (req, res) {
        chooseOperation(req.body, (err, operation_function) => {
            if (err) {
                res.status(500).send(err);
                return;
            }

            operation_function(req.body, (error, data) => {
                if (error) {
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
            default:
                break;
        }

        callback(null, operation_function);
    }

    function nullOperation(json, callback) {
        callback('Invalid operation');
    }

    app.listen(settings.HTTP_PORT, function () {
        console.log(`Express server running on ${settings.HTTP_PORT}`)
    });

}