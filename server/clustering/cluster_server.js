const Socket_Server = require('./Socket_Server'),
    Socket_Client = require('./Socket_Client'),
    insert = require('../../data_layer/insert'),
    node_Validator = require('../../validation/nodeValidator');


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

    connectToNode(node, o_node, callback){
        this.socket_client.connectToNode(node, o_node, callback);
    }

    addNode(new_node, callback){
        // need to clean up new node as it hads operation and user on it
        let validation = node_Validator(new_node);
        if(validation){
            return callback(validation);
        }

        let new_node_insert = {
            "operation":"insert",
            "schema":"system",
            "table":"hdb_nodes",
            "records": [new_node]
        }

        insert.insert(new_node_insert, function(err, result){
           if(err){
               return callback(err);
           }
           return callback(null, `successfully added ${new_node.name} to manifest`);


        });

    }















}


module.exports = ClusterServer;