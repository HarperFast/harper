'use strict';
const net = require('net'),
    settings = require('settings');

class Server {


    start (connection, port, callback) {
        let server = this;

        server.connection = connection;

        // starting the server
        this.connection.listen(port, settings.HDB_ADDRESS);
        // setuping the callback of the start function
        this.connection.on('listening', callback);


    }



}
module.exports = Server;