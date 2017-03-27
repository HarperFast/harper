'use strict';
const net = require('net'),
    settings = require('settings');

class Server {
    constructor (port, address) {
        this.port = settings.HDB_PORT;
        this.address = settings.HDB_ADDRESS;
    }

    start (connection, callback) {
        let server = this;

        server.connection = connection;

        // starting the server
        this.connection.listen(this.port, this.address);
        // setuping the callback of the start function
        this.connection.on('listening', callback);


    }



}
module.exports = Server;