"use strict";

const SocketServer = require('./SocketServer');
const SocketClient = require('./SocketClient');
const clone = require('clone');
const harper_logger = require('../../utility/logging/harper_logger');

class ClusterServer {
    constructor(node, nodes) {
        this.node = node;
        this.other_nodes = nodes;
        this.socket_server = new SocketServer(node);
        this.socket_client = [];

    }

    init(next) {
        this.socket_server.init(next);
        this.establishConnections();
    }

    establishConnections(){
        this.other_nodes.forEach((o_node)=>{
            this.createConnection(node, o_node);
        });
    }

    createConnection(o_node){
        //in order to avoid create multiple connections to the same end point
        let found_client =  this.socket_client.filter((client)=>{
            return client.other_node.host === o_node.host && client.other_node.port === o_node.port;
        });

        if(!found_client) {
            let new_client = new SocketClient(this.node, o_node);
            this.socket_client.push(new_client);
            new_client.connectToNode();
            new_client.createClientMessageHandlers();
        }
    }

    send(msg, res) {
        harper_logger.debug('node cluster msg out: ' + JSON.stringify(msg));
        let payload = {};
        payload.body = msg.body;
        payload.id = msg.id;
        payload.node = msg.node;

        this.socket_server.send(payload, res);
    }

    broadCast(msg) {
        harper_logger.debug('broadcast msg out: ' + JSON.stringify(msg));
        let operation = clone(msg.body.operation);
        for (let o_node in this.other_nodes) {
            let payload = {};
            payload.body = msg.body;
            payload.id = msg.id;

            if (!msg.body.operation) {
                payload.body.operation = operation;
            }
            payload.node = this.other_nodes[o_node];
            // senb working here

            global.cluster_server.send(payload);
        }


    }
}

module.exports = ClusterServer;