'use strict';
const net = require('net');
const env = require('../../utility/environment/environmentManager');
const logger = require('../../utility/logging/harper_logger');

class Server {


    start (connection, port, callback) {
        let server = this;

        server.connection = connection;

        // starting the server
        logger.info('inside start port:' + port);
        this.connection.listen(port, env.get('HDB_ADDRESS'));
        // setuping the callback of the start function
        this.connection.on('listening', callback);


    }



}
module.exports = Server;