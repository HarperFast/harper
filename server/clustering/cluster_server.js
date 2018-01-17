const Socket_Server = require('./Socket_Server'),
    Socket_Client = require('./Socket_Client'),
    insert = require('../../data_layer/insert'),
    clone = require('clone'),
    server_utilities = require('../server_utilities');


class ClusterServer {
    constructor(node) {
        this.socket_server = new Socket_Server(node);
        this.socket_client = new Socket_Client(node);


    }

    init(next) {
        this.socket_server.init(next);
    }

    establishConnections(next) {
        this.socket_client.establishConnections(next);
    }

    send(msg, res) {
        let payload = {};
        payload.body = msg.body;
        payload.id = msg.id;
        payload.node = msg.node;

        this.socket_server.send(payload, res);
    }

    broadCast(msg) {

        var operation = clone(msg.body.operation);
        for (let o_node in global.cluster_server.socket_server.other_nodes) {
            let payload = {};
            payload.body = msg.body;
            payload.id = msg.id;




            if (!msg.body.operation) {
                payload.body.operation = operation;
            }
            payload.node = global.cluster_server.socket_server.other_nodes[o_node];
            // senb working here


            global.cluster_server.send(payload);
        }


    }

    connectToNode(node, o_node, callback) {
        this.socket_client.connectToNode(node, o_node, callback);
    }


}


module.exports = ClusterServer;