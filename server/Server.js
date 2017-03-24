'use strict';
const net = require('net'),
    Client = require('./Client'),
    settings = require('settings'),
    insert = require('../data_layer/insert.js'),
    max_data_size = 65536;

class Server {
    constructor (port, address) {
        this.port = settings.HDB_PORT;
        this.address = settings.HDB_ADDRESS;
    }

    start (callback) {
        let server = this;

        server.connection = net.createServer((socket) => {
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

            socket.on('data', (data) => {
                socket_data += data;

                if(data.length <= max_data_size && this.isJson(socket_data)) {
                    let json = JSON.parse(socket_data);
                    insert.insert(json, function(err, data){
                        if(err) {
                            console.error(err);
                        }
                        console.timeEnd('insertTest');

                        socket.end(data);
                    });
                }
            });
        });
        // starting the server
        this.connection.listen(this.port, this.address);
        // setuping the callback of the start function
        this.connection.on('listening', callback);
    }

    isJson(string){
        try {
            JSON.parse(string);
        } catch (e) {
            return false;
        }
        return true;
    }

}
module.exports = Server;