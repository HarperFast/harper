const SocketConnector = require('./SocketConnector');
const socket_client = require('socketcluster-client');
const env = require('../utility/environment/environmentManager');

class NodeConnector {
    constructor(nodes){
        //spawn local connection
        this.spawnLocalConnection();
        this.spawnRemoteConnections(nodes);
    }

    spawnRemoteConnections(nodes){
        nodes.forEach(node =>{
            let connection = new SocketConnector(socket_client, node.name,node.hostname, node.port);
            if(node.subscriptions){
                node.subscriptions.forEach(subscription =>{
                    if(subscription.publish === true){
                        this.local_connection.subscribe(subscription.channel);
                    }

                    if(subscription.subscribe === true){
                        connection.subscribe()
                    }
                });
            }
        });
    }

    spawnLocalConnection(){
        this.local_connection = new SocketConnector(socket_client, 'local', null, env.get('CLUSTERING_PORT'));
    }
}

module.exports = NodeConnector;