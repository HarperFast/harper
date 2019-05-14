"use strict";
const terms = require('../../utility/hdbTerms');

const CONNECTION_STATUS_ENUM = {
    // This connection is in an error state
    ERR: "ERROR",
    // This connection is connected
    CONNECTED: "CONNECTED",
    // This connection is disconnected
    DISCONNECTED: "DISCONNECTED"
};

/**
 * This class represents a Job as it resides in the jobs table.
 */
class ConnectionStatus {
    constructor(host, port) {
        this.host = host;
        this.port = port;
        this.connection_status = CONNECTION_STATUS_ENUM.DISCONNECTED;
        this.direction = CONNECTION_STATUS_ENUM.BIDIRECTIONAL;
    }
}

class ClusterStatusObject {
    constructor() {
        // Array of type ConnectionStatus
        this.inbound_connections = [];
        this.outbound_connections = [];
        this.bidirectional_connections = [];
        this.my_node_name = undefined;
        this.my_node_port = undefined;
    }
}

module.exports = {
    ConnectionStatus,
    ClusterStatusObject,
    CONNECTION_STATUS_ENUM
};