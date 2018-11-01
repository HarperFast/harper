"use strict";
const search = require('../../data_layer/search');
const hdb_utils = require('../../utility/common_utils');
const SocketServer = require('./SocketServer');
const SocketClient = require('./SocketClient');
const clone = require('clone');
const log = require('../../utility/logging/harper_logger');
const {promisify} = require('util');

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
            let new_client = new SocketClient(this.node, o_node);
            this.socket_client.push(new_client);
            new_client.connectToNode();
            new_client.createClientMessageHandlers();
        } catch(e) {
            log.error(`Error establishing connection with ${o_node.name} at address ${o_node.host}`);
            log.error(e);
        }
    }

    establishAllConnections(){
        this.other_nodes.forEach((o_node)=>{
            this.establishConnection(o_node);
        });
    }

    send(msg, res) {
        log.debug('node cluster msg out: ' + JSON.stringify(msg));
        let payload = {};
        payload.body = msg.body;
        payload.id = msg.id;
        payload.node = msg.node;

        this.socket_server.send(payload, res);
    }

    broadCast(msg) {
        log.debug('broadcast msg out: ' + JSON.stringify(msg));
        let operation = clone(msg.body.operation);
        for (let o_node in this.other_nodes) {
            let payload = {};
            payload.body = msg.body;
            payload.id = msg.id;

            if (!msg.body.operation) {
                payload.body.operation = operation;
            }
            payload.node = this.other_nodes[o_node];
            global.cluster_server.send(payload);
        }
    }

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

        for(let curr_node of nodes) {
            for(let existing_node of this.node.other_nodes) {
                if(existing_node.name !== curr_node.name) {
                    this.node.other_nodes.push(curr_node);
                    // establishConnection handles any exceptions thrown.
                    this.establishConnection(curr_node);
                }
            }
        }
    }
}

module.exports = ClusterServer;