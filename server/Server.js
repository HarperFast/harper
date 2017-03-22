'use strict';
const net = require('net'),
    Client = require('./Client'),
    settings = require('settings'),
    insert = require('../data_layer/insert.js');

class Server {
    constructor (port, address) {
        this.port = settings.HDB_PORT;
        this.address = settings.HDB_ADDRESS;
        // Holds our currently connected clients
        this.clients = [];
    }
    /*
     * Starting the server
     * The callback argument is executed when the server finally inits
     */
    start (callback) {
        let server = this; // we'll use 'this' inside the callback below
        // our old onClientConnected
        server.connection = net.createServer((socket) => {
            let client = new Client(socket);
            console.log(`${client.name} connected.`);

            // TODO 1: Broadcast to everyone connected the new client connection
            server.broadcast(`${client.name} connected.\n`, client);

            // Storing client for later usage
            server.clients.push(client);

            // Triggered on message received by this client
            socket.on('data', (data) => {
                let insert_object = JSON.parse(data.toString().replace(/[\n\r]*$/, ''));

                socket.write(`We got your message`);

                console.time('insertTest');
                insert.insert(insert_object, function(err, data){
                    if(err) {
                        console.error(err);
                    }
                    console.timeEnd('insertTest');

                    //process.exit(0);
                });
            });

            // Triggered when this client disconnects
            socket.on('end', () => {
                // Removing the client from the list
                server.clients.splice(server.clients.indexOf(client), 1);

                // TODO 3: Broadcasting that this client left
                server.broadcast(`${client.name} disconnected.\n`);
            });
        });
        // starting the server
        this.connection.listen(this.port, this.address);
        // setuping the callback of the start function
        this.connection.on('listening', callback);
    }


    broadcast (message, clientSender) {
        this.clients.forEach((client) => {
            if (client === clientSender)
                return;
            client.receiveMessage(message);
        });
    }
}
module.exports = Server;