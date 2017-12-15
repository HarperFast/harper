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

    init(next){
        this.socket_server.init(next);
    }

    establishConnections(next){
        this.socket_client.establishConnections(next);
    }

    send(msg, res){
        this.socket_server.send(msg, res);
    }

    broadCast(req, res, operation_function){
            var operation = clone(req.body.operation);
            server_utilities.processLocalTransaction(req, res, operation_function, function (err, data) {
                if (!err) {
                    for (let o_node in global.cluster_server.socket_server.other_nodes) {
                        let payload = {};
                        payload.msg = req.body
                        if (data.id) {
                            payload.msg.id = data.id;

                        }

                        if (!req.body.operation) {
                            payload.msg.operation = operation;
                        }


                        payload.node = global.cluster_server.socket_server.other_nodes[o_node];
                        global.cluster_server.send(payload, res);
                    }

                }

            });



    }

    connectToNode(node, o_node, callback){
        this.socket_client.connectToNode(node, o_node, callback);
    }
















}


module.exports = ClusterServer;