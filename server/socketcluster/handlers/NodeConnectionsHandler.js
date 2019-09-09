"use strict";

const InterNodeSocketConnector = require('../connector/InterNodeSocketConnector');
const socket_client = require('socketcluster-client');
const sc_objects = require('../socketClusterObjects');
const log = require('../../../utility/logging/harper_logger');
const crypto_hash = require('../../../security/cryptoHash');
const SubscriptionObject = sc_objects.SubscriptionObject;
// eslint-disable-next-line no-unused-vars
const NodeObject = sc_objects.NodeObject;
const promisify = require('util').promisify;
const terms = require('../../../utility/hdbTerms');
const types = require('../types');
const env = require('../../../utility/environment/environmentManager');

class NodeConnectionsHandler {
    constructor(nodes, cluster_user, worker){
        if(!cluster_user){
            log.warn('no cluster_user, cannot connect to other nodes');
            return;
        }

        //spawn local connection
        this.worker = worker;
        this.nodes = nodes;

        if(this.worker === undefined || this.worker === null){
            throw new Error('worker is undefined, cannot spawn connections to other nodes');
        }

        this.publishin_promises = [];
        this.creds = {
            username: cluster_user.username,
            password: crypto_hash.decrypt(cluster_user.hash)
        };

        this.connection_timestamps = {};

        //only needed to handle publish as that is the one that needs a watcher / channel
        //sample structure: {"dev:dog":{watcher:()=>{}, channels:{ "edge1": socket}}
        this.publish_channel_connections = {};

        this.worker.scServer._middleware.publishIn.forEach(middleware_function => {
            this.publishin_promises.push(promisify(middleware_function).bind(this.worker.scServer));
        });

        //get nodes & spwan them, watch for node changes
        this.worker.exchange.subscribe(terms.INTERNAL_SC_CHANNELS.HDB_NODES).watch(data=>{
            if(data.add_node !== undefined){
                this.addNewNode(data.add_node);
            } else if(data.remove_node !== undefined){
                this.removeNode(data.remove_node);
            } else if(data.update_node !== undefined){
                this.update_node(data.update_node);
            }
        });

        //used to auto pub/sub the hdb_schema channel across the cluster
        this.HDB_Schema_Subscription = new SubscriptionObject(terms.INTERNAL_SC_CHANNELS.CREATE_SCHEMA, true, true);
        this.HDB_Table_Subscription = new SubscriptionObject(terms.INTERNAL_SC_CHANNELS.CREATE_TABLE, true, true);
        this.HDB_Attribute_Subscription = new SubscriptionObject(terms.INTERNAL_SC_CHANNELS.CREATE_ATTRIBUTE, true, true);
        this.connections = socket_client;
    }

    async initialize(){
        await this.spawnRemoteConnections(this.nodes);
    }

    /**
     *
     * @param  {Array.<NodeObject>} nodes
     */
    async spawnRemoteConnections(nodes){
        await nodes.forEach(async node => {
            await this.createNewConnection(node);
        });
    }

    async createNewConnection(node){
        // eslint-disable-next-line global-require
        let options = require('../../../json/interNodeConnectorOptions');
        log.trace(`Creating new connection to ${node.host}`);
        options.hostname = node.host;
        options.port = node.port;
        let additional_info = {
            server_name: node.name,
            client_name: env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY),
            subscriptions: node.subscriptions,
            connected_timestamp: null
        };
        let connection = new InterNodeSocketConnector(socket_client, this.worker, additional_info,options, this.creds, this.connection_timestamps);
        await connection.initialize();
        log.trace(`Done initializing new connection to ${node.host}`);
        node.subscriptions.push(this.HDB_Schema_Subscription);
        node.subscriptions.push(this.HDB_Table_Subscription);
        node.subscriptions.push(this.HDB_Attribute_Subscription);
        node.subscriptions.forEach(this.subscriptionManager.bind(this, connection));
    }

    /**
     *
     * @param new_node
     * @returns {Promise<void>}
     */
    async addNewNode(new_node){
        try {
            let node_exists = false;
            let connect_keys = Object.keys(this.connections.clients);
            for (let x = 0; x < connect_keys.length; x++) {
                let key = connect_keys[x];
                let socket = this.connections.clients[key];
                if (socket.additional_info && socket.additional_info.server_name === new_node.name) {
                    node_exists = true;
                    return;
                }
            }

            if (node_exists) {
                log.info(`node ${new_node.name} already exists`);
                return;
            }

            await this.createNewConnection(new_node);
        }catch(e){
            log.error(e);
        }
    }

    /**
     *
     * @param remove_node
     */
    removeNode(remove_node){
        try {
            let connect_keys = Object.keys(this.connections.clients);
            for (let x = 0; x < connect_keys.length; x++) {
                let key = connect_keys[x];
                let socket = this.connections.clients[key];
                if (socket.additional_info && socket.additional_info.server_name === remove_node.name) {
                    this.connections.destroy(socket);
                }

                //remove node from all publish connections
                for(let channel in this.publish_channel_connections){
                    for(let socket_name in this.publish_channel_connections[channel]){
                        if(socket_name === remove_node.name){
                            delete this.publish_channel_connections[channel][socket_name];
                        }
                    }
                }
            }
        } catch(e){
            log.error(e);
        }
    }

    /**
     * on update we simply remove and readd the node so that all changes take effect properly.
     * @param update_node
     */
    async update_node(update_node){
        try {
            let connect_keys = Object.keys(this.connections.clients);
            for (let x = 0; x < connect_keys.length; x++) {
                let key = connect_keys[x];
                let connection = this.connections.clients[key];
                if (connection.additional_info.server_name === update_node.name) {
                    this.removeNode(update_node);
                    await this.addNewNode(update_node);
                    return;
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
        try {
            if (subscription.publish === true) {
                if (this.publish_channel_connections[subscription.channel] === undefined) {
                    this.publish_channel_connections[subscription.channel] = {};
                    let sub_channel = this.worker.exchange.subscribe(subscription.channel);

                    sub_channel.watch(this.subscriptionChannelWatcher.bind(this, subscription.channel));
                }

                //add the connection to the channel map
                this.publish_channel_connections[subscription.channel][connection.additional_info.server_name] = connection;
            }

            if (subscription.subscribe === true) {
                //we need to observe the channel remotely and send the data locally
                log.trace(`Worker is subscribing to ${subscription.channel}`);
                connection.subscribe(subscription.channel, this.assignTransactionToChild.bind(this, subscription.channel, connection.socket));
            }
        } catch(e){
            log.error(e);
        }
    }

    /**
     *
     * @param channel
     * @param data
     */
    subscriptionChannelWatcher(channel, data){
        try {
            //TODO: This needs to be corrected and tested.
            if(connection.socket.state === connection.socket.OPEN && connection.socket.authState === connection.socket.AUTHENTICATED) {
                // We need to delete the transacted flag here so it isn't evaluated on the remote side.
                if(data.__transacted) {
                    delete data.__transacted;
                }

                if(!data.channel) {
                    // worker middleware expects a channel in order to evaluate properly, so append it here.
                    data.channel = subscription.channel;
                }

                let remote_host_name = (env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY) === connection.socket.additional_info.client_name ?
                    connection.socket.additional_info.server_name : connection.socket.additional_info.client_name);
                if(data.__originator && data.__originator[remote_host_name] === types.ORIGINATOR_SET_VALUE) {
                    log.info('Message contains originator matching remote host, swallowing message.');
                    return;
                }
                log.trace(`Worker is publishing to ${subscription.channel}`);
                connection.publish(subscription.channel, data);
            }
            let connections = Object.values(this.publish_channel_connections[channel]);
            connections.forEach(connection => {
                if (connection.socket.state === connection.socket.OPEN && connection.socket.authState === connection.socket.AUTHENTICATED) {
                    log.trace('publishing out');
                    connection.publish(channel, data);
                }
            });
        } catch(e){
            log.error(e);
        }
    }

    async assignTransactionToChild(channel, socket, data){
        let req = {
            channel: channel,
            data: data,
            socket: socket
        };

        try {
            await this.runPublishInMiddleware(req);
        } catch(err) {
            log.info(`Middleware objection found on channel: ${channel}. Not consuming message.`);
        }
    }

    async runPublishInMiddleware(request) {
        let result = undefined;
        for (let x = 0; x < this.publishin_promises.length; x++) {
            try {
                result = await this.publishin_promises[x](request);
            } catch(e) {
                log.error(e);
            }
            if(result) {
                throw new Error('Got objection from publishin middleware');
            }
        }
    }

}

module.exports = NodeConnectionsHandler;