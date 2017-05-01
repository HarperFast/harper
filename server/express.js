const cluster = require('cluster');
const numCPUs = 3;

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
        app = express(),
        bodyParser = require('body-parser'),
        insert = require('../data_layer/insert');

    app.use(bodyParser.json()); // support json encoded bodies
    app.use(bodyParser.urlencoded({extended: true}));

    app.post('/', function (req, res) {
        insert.insert(req.body, function (err, data) {
            if (err) {
                res.status(500).send(err);
                return;
            }

            res.status(200).send(JSON.stringify(data));
        });
        //console.log(req.body);

    });

    app.listen(5299, function () {
        console.log('Example app listening on port 5299!')
    });
}