const net = require('net'),
    Client = require('./Client'),
    search  = require('../../data_layer/search.js'),
    hdb_delete = require('../../data_layer/delete.js'),
    logger = require('../../utility/logging/harper_logger'),
    max_data_size = 65536;

const util = require('util');
const insert = require('../data_layer/insert');
const cb_insert_insert = util.callbackify(insert.insert);

module.exports = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let client = new Client(socket);
    let socket_data = '';
    logger.info(`${client.name} connected.`);

    socket.on('error', (err) => {
        logger.error(`Socket ${client.name} fail: ${err}`);
    });

    socket.on('close', (err) => {
        logger.info(`Socket ${client.name} disconnected`);
    });

    socket.on('data', onSocketData);

    function onSocketData(data){
        socket_data += data;

        if(data.length <= max_data_size && isJson(socket_data)) {
            let json = JSON.parse(socket_data);
            if(!Object.keys(json)[0]){
                socket.end('Missing operation');
                return;
            }

            handleOperation(json, function(err, data){
                if(err) {
                    logger.error(err);
                    socket.end(JSON.stringify(err));
                    return;
                }
                logger.info(`${client.name} ${data}`);

                socket.end(JSON.stringify(data));
                return;
            });
        }
    }
});


function handleOperation(json, callback){
    let payload = json[Object.keys(json)[0]];
    logger.info(payload);
    switch(Object.keys(json)[0]){
        case 'write':
            cb_insert_insert(payload, (err, data) => {
            callback(err, data);
            });
            break;
        case 'search_by_hash':
            search.searchByHash(payload, function(err, data){
                callback(err, data);
            });
            break;
        case 'search_by_value':
            search.searchByValue(payload, function(err, data){
                callback(err, data);
            });
            break;
        case 'delete':
            hdb_delete.delete(payload, function(err, data){
                callback(err, data);
            });
            break;
    }
    return;
}

function isJson(string){
    try {
        JSON.parse(string);
    } catch (e) {
        return false;
    }
    return true;
}