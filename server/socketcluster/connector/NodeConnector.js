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
const terms = require('../../../utility/hdbTerms');

class NodeConnector {
    constructor(nodes, cluster_user, worker){
        if(!cluster_user){
            log.warn('no cluster_user, cannot connect to other nodes');
            return;
        }

        //spawn local connection
        this.worker = worker;

        if(this.worker === undefined || this.worker === null){
            throw new Error('worker is undefined, cannot spawn connections to other nodes');
        }

        this.publishin_promises = [];
        this.creds = {
            username: cluster_user.username,
            password: crypto_hash.decrypt(cluster_user.hash)
        };

        this.worker.scServer._middleware.publishIn.forEach(middleware_function=>{
            this.publishin_promises.push(promisify(middleware_function).bind(this.worker.scServer));
        });

        //used to auto pub/sub the hdb_schema channel across the cluster
        this.HDB_Schema_Subscription = new SubscriptionObject(terms.INTERNAL_SC_CHANNELS.CREATE_SCHEMA, true, true);
        this.HDB_Table_Subscription = new SubscriptionObject(terms.INTERNAL_SC_CHANNELS.CREATE_TABLE, true, true);
        this.HDB_Attribute_Subscription = new SubscriptionObject(terms.INTERNAL_SC_CHANNELS.CREATE_ATTRIBUTE, true, true);

        this.AssignToHdbChildWorkerRule = new AssignToHdbChildWorkerRule();
        this.connections = socket_client;
        this.spawnRemoteConnections(nodes);

        //get nodes & spwan them, watch for node changes
        this.worker.exchange.subscribe(terms.INTERNAL_SC_CHANNELS.HDB_NODES).watch(data=>{
            if(data.add_node !== undefined){
                this.addNewNode(data.add_node);
            } else if(data.remove_node !== undefined){
                this.removeNode(data.remove_node);
            }
        });
    }

    /**
     *
     * @param  {Array.<NodeObject>} nodes
     */
    spawnRemoteConnections(nodes){
        nodes.forEach(node =>{
            this.createNewConnection(node);
        });
    }

    createNewConnection(node){
        let options = require('../../../json/connectorOptions');
        options.hostname = node.host;
        options.port = node.port;
        let additional_info = {
            name: node.name,
            subscriptions: node.subscriptions
        };
        let connection = new SocketConnector(socket_client, additional_info,options, this.creds);

        if(node.subscriptions){
            node.subscriptions.push(this.HDB_Schema_Subscription);
            node.subscriptions.push(this.HDB_Table_Subscription);
            node.subscriptions.push(this.HDB_Attribute_Subscription);
            node.subscriptions.forEach(this.subscriptionManager.bind(this, connection));
        }
    }

    addNewNode(new_node){
        try {
            let node_exists = false;
            let connect_keys = Object.keys(this.connections.clients);
            for (let x = 0; x < connect_keys.length; x++) {
                let key = connect_keys[x];
                let socket = this.connections.clients[key];
                if (socket.host === new_node.host && socket.port === new_node.port) {
                    node_exists = true;
                    return;
                }
            }

            if (node_exists) {
                return;
            }

            this.createNewConnection(new_node);
        }catch(e){
            log.error(e);
        }
    }

    removeNode(remove_node){
        try {
            let connect_keys = Object.keys(this.connections.clients);
            for (let x = 0; x < connect_keys.length; x++) {
                let key = connect_keys[x];
                let socket = this.connections.clients[key];
                if (socket.additional_info.name === remove_node.name) {
                    this.connections.destroy(socket);
                }
            }
        } catch(e){
            log.error(e);
        }
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
                log.trace('sending out');
                connection.publish(subscription.channel, data);
            });
        }

        if(subscription.subscribe === true){
            //we need to observe the channel remotely and send the data locally
            connection.subscribe(subscription.channel, this.assignTransactionToChild.bind(this, subscription.channel, connection.socket));
        }
    }

    async assignTransactionToChild(channel, socket, data){
        let req = {
            channel: channel,
            data: data,
            socket: socket
        };

        this.runMiddleware(req).then(()=>{

        });
    }

    async runMiddleware(request){
        for (let x = 0; x < this.publishin_promises.length; x++) {
            try {
                await this.publishin_promises[x](request);
            } catch(e){
                log.error(e);
            }
        }
    }

}

module.exports = NodeConnector;