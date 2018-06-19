const Socket_Server = require('./Socket_Server'),
    Socket_Client = require('./Socket_Client'),
    insert = require('../../data_layer/insert'),
    clone = require('clone'),
    harper_logger = require('../../utility/logging/harper_logger');
server_utilities = require('../server_utilities');


class ClusterServer {
    constructor(node, nodes) {
        this.node = node;
        this.other_nodes = nodes;
        this.socket_server = new Socket_Server(node);
        //this.socket_client = new Socket_Client(node);
        this.socket_client = [];

    }

    init(next) {
        this.socket_server.init(next);
        this.establishConnections();
    }

    establishConnections(){
        this.other_nodes.forEach((o_node)=>{
            let new_client = new Socket_Client(this.node, o_node);
            this.socket_client.push(new_client);
            new_client.connectToNode();
            new_client.createClientMessageHandlers();
        });
    }

    /*establishConnections(next) {
        this.socket_client.establishConnections(next);
    }*/

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
        var operation = clone(msg.body.operation);
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