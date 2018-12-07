"use strict";
const search = require('../../data_layer/search');
const SocketServer = require('./SocketServer');
const SocketClient = require('./SocketClient');
const clone = require('clone');
const log = require('../../utility/logging/harper_logger');
const {promisify} = require('util');

const SCHEMA_OPERATIONS = ['create_schema', 'drop_schema', 'create_table', 'drop_table', 'create_attribute'];

//promisified functions
const p_search_searchbyvalue = promisify(search.searchByValue);

class ClusterServer {
    constructor(node, nodes) {
        this.node = node;
        this.other_nodes = nodes;
        this.socket_server = new SocketServer(node);
        this.socket_client = [];
    }

    init(next) {
        this.socket_server.init(next);
        this.establishAllConnections();
    }

    establishConnection(o_node) {
        try {
            let found_client =  this.socket_client.filter((client)=>{
                return client.other_node.host === o_node.host && client.other_node.port === o_node.port;
            });

            if(!found_client || found_client.length === 0) {
                let new_client = new SocketClient(this.node, o_node, true);
                this.socket_client.push(new_client);
                new_client.connectToNode();
                new_client.createClientMessageHandlers();
            }
        } catch(e) {
            log.error(`Error establishing connection with ${o_node.name} at address ${o_node.host}`);
            log.error(e);
        }
    }

    removeConnection(o_node) {
        try {
            let found_client = this.socket_client.filter((client)=>{
                return client.other_node.host === o_node.host && client.other_node.port === o_node.port;
            });

            if(found_client && found_client[0]) {
                found_client[0].disconnectNode();
            }

        } catch(err) {
            log.error(`Error removing connection with ${o_node.name} at address ${o_node.host}`);
            log.error(err);
        }
    }


    establishAllConnections(){
        this.other_nodes.forEach((o_node)=>{
            this.establishConnection(o_node);
        });
    }

    send(msg, res) {
        try {
            log.debug('node cluster msg out: ' + JSON.stringify(msg));
            let payload = {};
            payload.body = msg.body;
            payload.id = msg.id;
            payload.node = msg.node;

            let found_node = this.socket_client.filter((client) => {
                return client.other_node.name;
            });

            if (found_node && Array.isArray(found_node) && found_node.length > 0) {
                found_node[0].send(payload).
                    then(() => {return;});
            }
        } catch (e) {
            log.error(e);
        }
    }

    broadCast(msg) {
        try {
            log.debug('broadcast msg out: ' + JSON.stringify(msg));
            let operation = clone(msg.body.operation);

            for (let o_node in this.socket_client) {
                //if this is a schema operation we send to every connection, or if it's not we only send to clients who are established
                if(SCHEMA_OPERATIONS.indexOf(operation) >= 0 || (SCHEMA_OPERATIONS.indexOf(operation) < 0 && this.socket_client[o_node].is_node)) {
                    let payload = {};
                    payload.body = msg.body;
                    payload.id = msg.id;

                    if (!msg.body.operation) {
                        payload.body.operation = operation;
                    }
                    payload.node = this.socket_client[o_node].other_node;
                    this.socket_client[o_node].send(payload)
                        .then(()=>{
                            return;
                        });
                }
            }
        } catch (e) {
            log.error(e);
        }
    }

    /**
     * Scan nodes does a comparison between a search against hdb_nodes and any existing connections that exist in
     * this.other_nodes.  If there are nodes found in one but not the other, we need to either connect or disconnect
     * those nodes.
     * @returns {Promise<void>}
     */
    async scanNodes() {
        log.debug(`Scanning for new clustering nodes`);
        let search_obj = {
            "table": "hdb_nodes",
            "schema": "system",
            "search_attribute": "host",
            "hash_attribute": "name",
            "search_value": "*",
            "get_attributes": ["*"]
        };

        let nodes = await p_search_searchbyvalue(search_obj).catch((e) => {
            log.error(`Error searching for nodes.`);
            throw e;
        });

        // If there is nothing in other nodes, anything found in the nodes search is assumed to be new and should be opened
        let added_nodes = ((this.node.other_nodes.length === 0) ? nodes : undefined);
        //If there is nothing found in existing nodes, anything found in other_nodes has been removed and should be closed.
        let removed_nodes = ((nodes.length === 0) ? this.node.other_nodes : undefined);
        try {
            //find nodes that were found in a search but don't yet exist in other_nodes.
            if(!added_nodes && nodes.length > 0) {
                added_nodes = nodes.filter(item => !this.node.other_nodes.some(other => item.name === other.name));
            }
            //find nodes that exist in other_nodes but no longer exist in a node search.
            if(!removed_nodes && this.node.other_nodes.length > 0) {
                removed_nodes = this.node.other_nodes.filter(item => !nodes.some(other => item.name === other.name));
            }
        } catch (err) {
            log.info('Had a problem detecting node changes.');
        } finally {
            if(added_nodes) {
                for (let curr_node of added_nodes) {
                    this.node.other_nodes.push(curr_node);
                    // establishConnection handles any exceptions thrown.
                    log.info(`Establishing connection with cluster node ${curr_node.name}`);
                    this.establishConnection(curr_node);
                }
            }

            if(removed_nodes) {
                for (let removed_node of removed_nodes) {
                    log.info(`Removing connection with cluster node ${removed_node.name}`);
                    this.removeConnection(removed_node);
                    for( let i = 0; i < this.node.other_nodes.length; i++){
                        if ( this.node.other_nodes[i].name === removed_node.name) {
                            this.node.other_nodes.splice(i, 1);
                        }
                    }
                }
            }
        }
    }
}

module.exports = ClusterServer;