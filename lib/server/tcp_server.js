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
    console.log(`${client.name} connected.`);

    console.time('insertTest');

    socket.on('error', (err) => {
        console.error(`Socket ${client.name} fail: ${err}`);
    });

    socket.on('close', (err) => {
        console.log(`Socket ${client.name} disconnected`);
    });

    socket.on('data', onSocketData);

    function onSocketData(data){
        socket_data += data;

        if(data.length <= max_data_size && isJson(socket_data)) {
            let json = JSON.parse(socket_data);
            if(!json.operation){
                socket.end('Missing operation');
                return;
            }

            handleOperation(json, function(err, data){
                if(err) {
                    console.error(err);
                    socket.end(err);
                    return;
                }
                console.log(`${client.name} ${data}`);
                console.timeEnd('insertTest');
                socket.end(data);
                return;
            });



        }
    }
});


function handleOperation(json, callback){
    switch(json.operation){
        case 'insert':
            insert.insert(json, function(err, data){
                callback(err, data);
            });
            break;
        case 'update':
            insert.insert(json, function(err, data){
                callback(err, data);
            });
            break;
        case 'search_by_hash':
            search.searchByHash(json, function(err, data){
                callback(err, data);
            });
            break;
        case 'search_by_hashes':
            search.searchByHashes(json, function(err, data){
                callback(err, data);
            });
            break;
        case 'search_by_value':
            search.searchByValue(json, function(err, data){
                callback(err, data);
            });
            break;
        case 'delete':
            hdb_delete.delete(json, function(err, data){
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

