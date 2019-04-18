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
        this.spawnRemoteConnections(nodes);
        this.connections = socket_client;
        //used to auto pub/sub the hdb_schema channel across the cluster
        this.HDB_Schema_Subscription = new SubscriptionObject('internal:create_schema', true, true);
        this.HDB_Table_Subscription = new SubscriptionObject('internal:create_table', true, true);
        this.HDB_Attribute_Subscription = new SubscriptionObject('internal:create_attribute', true, true);
        //get nodes & spwan them, watch for node changes
        this.worker.exchange.subscribe('hdb_nodes').watch(data=>{
            //TODO create / destroy node here
        });
    }

    /**
     *
     * @param  {Array.<NodeObject>} nodes
     */
    spawnRemoteConnections(nodes){
        nodes.forEach(node =>{
            let options = require('./connectorOptions');
            options.hostname = node.host;
            options.port = node.port;
            let connection = new SocketConnector(socket_client, node.name,options, {username: 'kyle', password:'test'});

            if(node.subscriptions){
                node.subscriptions.push(this.HDB_Schema_Subscription);
                node.subscriptions.push(this.HDB_Table_Subscription);
                node.subscriptions.push(this.HDB_Attribute_Subscription);
                node.subscriptions.forEach(this.subscriptionManager.bind(this, connection));
            }
        });
    }

    /**
     *
     * @param connection
     * @param {SubscriptionObject} subscription
     */
    subscriptionManager(connection, subscription){
        if(subscription.publish){
            //we need to observe the channel locally and push the data remotely.
            let sub_channel = this.worker.exchange.subscribe(subscription.channel);
            sub_channel.watch(data=>{
                console.log('sending out');
                connection.publish(subscription.channel, data);
            });
        }

        if(subscription.subscribe === true){
            //we need to observe the channel remotely and send the data locally
            connection.subscribe(subscription.channel, this.worker.sendTransactionToWorker.bind(this.worker, subscription.channel));

        }
    }

}

module.exports = NodeConnector;