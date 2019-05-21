"use strict";

const SocketConnector = require('./SocketConnector');
const socket_client = require('socketcluster-client');
const sc_objects = require('../socketClusterObjects');
const AssignToHdbChildWorkerRule = require('../decisionMatrix/rules/AssignToHdbChildWorkerRule');
const log = require('../../../utility/logging/harper_logger');
const crypto_hash = require('../../../security/cryptoHash');
const SubscriptionObject = sc_objects.SubscriptionObject;
const NodeObject = sc_objects.NodeObject;
const promisify = require('util').promisify;

class NodeConnector {
    constructor(nodes, cluster_user, worker){
        if(!cluster_user){
            log.warn('no cluster_user, cannot connect to other nodes');
            return;
        }

        //spawn local connection
        this.worker = worker;
        this.publishin_promises = [];
        this.creds = {
            username: cluster_user.username,
            password: crypto_hash.decrypt(cluster_user.hash)
        };

        this.nodes = nodes;

        this.worker.scServer._middleware.publishIn.forEach(middleware_function=>{
            this.publishin_promises.push(promisify(middleware_function).bind(this.worker.scServer));
        });

        //used to auto pub/sub the hdb_schema channel across the cluster
        this.HDB_Schema_Subscription = new SubscriptionObject('internal:create_schema', true, true);
        this.HDB_Table_Subscription = new SubscriptionObject('internal:create_table', true, true);
        this.HDB_Attribute_Subscription = new SubscriptionObject('internal:create_attribute', true, true);

        this.AssignToHdbChildWorkerRule = new AssignToHdbChildWorkerRule();
        this.connections = socket_client;
        this.spawnRemoteConnections(nodes);

        //get nodes & spwan them, watch for node changes
        this.worker.exchange.subscribe('internal:hdb_nodes').watch(data=>{
            //TODO create / destroy node here
        });
    }

    /**
     *
     * @param  {Array.<NodeObject>} nodes
     */
    spawnRemoteConnections(nodes){
        nodes.forEach(node =>{
            let options = require('../../../json/connectorOptions');
            options.hostname = node.host;
            options.port = node.port;
            let connection = new SocketConnector(socket_client, node.name,options, this.creds);

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
        if(subscription.publish === true){
            //we need to observe the channel locally and push the data remotely.
            let sub_channel = this.worker.exchange.subscribe(subscription.channel);
            sub_channel.watch(data=>{
                console.log('sending out');
                connection.publish(subscription.channel, data);
            });
        }

        if(subscription.subscribe === true){
            //we need to observe the channel remotely and send the data locally
            connection.subscribe(subscription.channel, this.assignTransactionToChild.bind(this, subscription.channel));
        }
    }

    async assignTransactionToChild(channel, data){
        let req = {
            channel: channel,
            data: data
        };

        this.runMiddleware(req).then(()=>{

        });
    }

    async runMiddleware(request){
        for (let x = 0; x < this.publishin_promises.length; x++) {
            try {
                await this.publishin_promises[x](request);
            } catch(e){
                console.error(e);
            }
        }
    }

}

module.exports = NodeConnector;