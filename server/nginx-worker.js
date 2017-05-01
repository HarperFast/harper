let fs = require('fs')
let http = require('http')
let type = 'nginx'
let hit = 0, id

class Worker {
    constructor () {
        id = Number(process.env.id)
        process.title = 'node '+ type +' worker '+ id
        this.webserver()

    }



    webserver () {
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

        let port = 5299 + id;

        app.listen(port, function () {
            console.log('Example app listening on port '+port+ '!')
        });
    }
}

new Worker()
