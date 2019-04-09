const SocketConnector = require('./SocketConnector');
const socket_client = require('socketcluster-client');
const env = require('../utility/environment/environmentManager');

class NodeConnector {
    constructor(nodes){
        //spawn local connection
        this.channel_map = {};
        this.spawnLocalConnection();
        this.spawnRemoteConnections(nodes);
    }

    spawnRemoteConnections(nodes){
        nodes.forEach(node =>{
            let connection = new SocketConnector(socket_client, node.name,node.hostname, node.port);
            if(node.subscriptions){
                node.subscriptions.forEach(subscription =>{
                    if(subscription.publish === true){
                        this.local_connection.subscribe(subscription.channel, this.localSubscribeWatcher);
                        if(this.channel_map !== undefined){
                            this.channel_map[subscription.channel] = [];
                        }
                        this.channel_map[subscription.channel].push(connection);
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

    localSubscribeWatcher(data){
        console.log(channel + ' ' + JSON.parse(data));
    }
}

module.exports = NodeConnector;