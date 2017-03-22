'use strict';

class Client {

    constructor (socket) {
        this.address = socket.remoteAddress;
        this.port    = socket.remotePort;
        this.name    = `${this.address}:${this.port}`;
        this.socket  = socket;
    }

    receiveMessage (message) {
        this.socket.write(message);
    }

}
module.exports = Client;