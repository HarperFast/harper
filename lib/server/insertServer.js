const net = require('net'),
    Client = require('./Client'),
    insert = require('../../data_layer/insert.js'),
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
            insert.insert(json, function(err, data){
                if(err) {
                    console.error(err);
                }
                console.log(`${client.name} ${data}`);
                console.timeEnd('insertTest');

                socket.end(data);
            });
        }
    }
});

function isJson(string){
    try {
        JSON.parse(string);
    } catch (e) {
        return false;
    }
    return true;
}

