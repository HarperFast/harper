const net = require('net'),
    Client = require('./Client'),
    insert = require('../../data_layer/insert.js'),
    search  = require('../../data_layer/search.js'),
    hdb_delete = require('../../data_layer/delete.js')
    max_data_size = 65536;

module.exports = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let client = new Client(socket);
    let socket_data = '';
    winston.info(`${client.name} connected.`);



    socket.on('error', (err) => {
        winston.error(`Socket ${client.name} fail: ${err}`);
    });

    socket.on('close', (err) => {
        winston.info(`Socket ${client.name} disconnected`);
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
                    winston.error(err);
                    socket.end(JSON.stringify(err));
                    return;
                }
                winston.info(`${client.name} ${data}`);

                socket.end(JSON.stringify(data));
                return;
            });



        }
    }
});


function handleOperation(json, callback){
    let payload = json[Object.keys(json)[0]];
    winston.info(payload);
    switch(Object.keys(json)[0]){
        case 'write':
            insert.insert(payload, function(err, data){
                callback(err, data);
            });
            break;
        case 'search_by_hash':
            search.searchByHash(payload, function(err, data){
                callback(err, data);
            });
            break;
        case 'search_by_hashes':
            search.searchByHashes(payload, function(err, data){
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

