'use strict';
const net = require('net'),
    PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
    hdb_properties.append(hdb_properties.get('settings_path'));

class Server {


    start (connection, port, callback) {
        let server = this;

        server.connection = connection;

        // starting the server
        winston.info('inside start port:' + port);
        this.connection.listen(port, hdb_properties.get('HDB_ADDRESS'));
        // setuping the callback of the start function
        this.connection.on('listening', callback);


    }



}
module.exports = Server;