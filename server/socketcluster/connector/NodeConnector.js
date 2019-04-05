const SocketConnector = require('./SocketConnector');
const socket_client = require('socketcluster-client');

class NodeConnector {
    constructor(nodes){
        this.spawnConnections(nodes);
    }

    spawnConnections(nodes){
        nodes.forEach(node =>{
            let connection = new SocketConnector(socket_client,node.hostname, node.port, node.name);
            if(node.subscriptions){
                node.subscriptions.forEach(subscription =>{

                });
            }
        });
    }
}

module.exports = NodeConnector;