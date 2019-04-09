"use strict";

const SocketConnector = require('./SocketConnector');
const socket_client = require('socketcluster-client');
const sc_objects = require('../socketClusterObjects');
const SubscriptionObject = sc_objects.SubscriptionObject;
const NodeObject = sc_objects.NodeObject;

class NodeConnector {
    constructor(nodes, worker){
        //spawn local connection
        this.worker = worker;
        this.channel_map = {};
        this.spawnRemoteConnections(nodes);

        //get nodes & spwan them, watch for node changes

        this.worker.exchange.subscribe('hdb_nodes').watch(data=>{
            //create / destroy node here
        });
    }

    /**
     *
     * @param  {Array.<NodeObject>} nodes
     */
    spawnRemoteConnections(nodes){
        nodes.forEach(node =>{
            let connection = new SocketConnector(socket_client, node.name,node.host, node.port);
            if(node.subscriptions){
                node.subscriptions.forEach(this.subscriptionManager.bind(this, connection));
            }
        });
    }

    /**
     *
     * @param {SubscriptionObject} subscription
     */
    subscriptionManager(connection, subscription){
        if(subscription.publish){
            //we need to observe the channel locally and push the data remotely.
            let sub_channel = this.worker.exchange.subscribe(subscription.channel);
            sub_channel.watch(data=>{
                connection.publish(subscription.channel, data);
            });
        }

        if(subscription.subscribe === true){
            //we need to observe the channel remotely and send the data locally
            connection.subscribe(subscription.channel, this.channelWatcher);

        }
    }

    channelWatcher(data){
        //figure out a worker or do we create a local_op end point and pass the payload?
        console.log(data);
    }

}

module.exports = NodeConnector;