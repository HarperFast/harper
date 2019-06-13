"use strict";

class ConnectionDetails {
    constructor(id, host_address, host_port, state) {
        this.id = id;
        this.host_address = host_address;
        this.host_port = host_port;
        this.state = state;
    }
}

function getWorkerStatus(status_response_msg, worker) {
    if(!worker.node_connector) {
        return [];
    }

    if(worker.scServer.clients) {
        let client_keys = Object.keys(worker.scServer.clients);
        for(let i=0; i<client_keys.length; i++) {
            let client = worker.scServer.clients[client_keys[i]];//worker.scServer.clients[i];
            let conn = new ConnectionDetails(client.id, client.remoteAddress, client.remotePort, client.state);
            status_response_msg.inbound_connections.push(conn);
        }
    }
}

module.exports = {
    ConnectionDetails,
    getWorkerStatus
};