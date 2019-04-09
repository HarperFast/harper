const SocketConnector = require('./SocketConnector');
const socket_client = require('socketcluster-client');

class NodeConnector {
    constructor(nodes){
        //spawn local connection
        this.channel_map = {};
        this.spawnRemoteConnections(nodes);
    }

    spawnRemoteConnections(nodes){
        nodes.forEach(node =>{
            let connection = new SocketConnector(socket_client, node.name,node.hostname, node.port);
            if(node.subscriptions){
                node.subscriptions.forEach(subscription =>{

                    if(subscription.subscribe === true){
                        connection.subscribe()
                    }
                });
            }
        });
    }

    channelWatcher(data){
        //figure out a worker or do we create a local_op end point and pass the payload?
    }

}

module.exports = NodeConnector;