#!/usr/bin/env node
'use strict';
    const     settings = require('settings'),
        insert = require('../data_layer/insert.js'),
        search  = require('../data_layer/search.js'),
        hdb_delete = require('../data_layer/delete.js'),
        max_data_size = 65536,
        net = require('net'),
        cluster = require('cluster'),
    winston=require('winston');

winston.configure({
    transports: [
        new (winston.transports.File)({ filename: 'error.log' })
    ]
});

    var numPorts = settings.TCP_PORT_RANGE_END - settings.TCP_PORT_RANGE_BEGIN;
    var counter =0;

var port = process.argv[2] ? process.argv[2] : 9925;

net.createServer(conn).listen(port, settings.HDB_ADDRESS);

function conn(socket) {
    socket.setEncoding('utf8');
    let socket_data = '';
    console.log('connected');
    socket.on('error', (err) => {
        console.error(`Socket ${client.name} fail: ${err}`);
    });

    socket.on('close', (err) => {
        //console.log(`Socket ${client.name} disconnected`);
    });

    socket.on('data', onSocketData);

    function onSocketData(data) {
        //socket_data += data;
        insert.insert(JSON.parse(data).write, function (err, results) {
            if(err) {
                winston.log('error', err);
            }
            winston.log('info', results);
            socket.end(JSON.stringify(results));
            return;
            //callback(err, data);
        });
        /*if (data.length <= max_data_size && isJson(socket_data)) {
            let json = JSON.parse(socket_data);

            if (!Object.keys(json)[0]) {
                socket.end('Missing operation');
                return;
            }

            handleOperation(json, function (err, data) {
                if (err) {
                    console.error(err);
                    socket.end(JSON.stringify(err));
                    return;
                }
                //console.log(`${client.name} ${data}`);

                socket.end(JSON.stringify(data));
                return;
            });


        }*/
    }

    function handleOperation(json, callback) {
        let payload = json[Object.keys(json)[0]];
        //console.log(payload);
        switch (Object.keys(json)[0]) {
            case 'write':
                insert.insert(payload, function (err, data) {
                    callback(err, data);
                });
                break;
            case 'search_by_hash':
                search.searchByHash(payload, function (err, data) {
                    callback(err, data);
                });
                break;
            case 'search_by_hashes':
                search.searchByHashes(payload, function (err, data) {
                    callback(err, data);
                });
                break;
            case 'search_by_value':
                search.searchByValue(payload, function (err, data) {
                    callback(err, data);
                });
                break;
            case 'delete':
                hdb_delete.delete(payload, function (err, data) {
                    callback(err, data);
                });
                break;
        }
        return;
    }


    function isJson(string) {
        try {
            JSON.parse(string);
        } catch (e) {
            return false;
        }
        return true;
    }
}
/*
if (cluster.isMaster) {
    // Fork workers.
    for (var i = 0; i <= numPorts; i++) {
        cluster.fork({port:settings.TCP_PORT_RANGE_BEGIN + i});
    }
} else {

    let port = process.env['port'];
    console.log(port);
    net.createServer(conn).listen(port, settings.HDB_ADDRESS);
    counter++;
}*/
