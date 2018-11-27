"use strict";

const harper_logger = require('../../utility/logging/harper_logger');
const search = require('../../data_layer/search');
const insert = require('../../data_layer/insert');
const delete_ = require('../../data_layer/delete');
const schema = require('../../data_layer/schema');
const server_utilities = require('../serverUtilities');
const auth = require('../../security/auth');

const SocketClient = require('./SocketClient');
const cluster_handlers = require('./clusterHandlers');

class SocketServer {
    constructor(node) {
        this.node = node;
        this.name = node.name;
        this.port = node.port;
        this.other_nodes = node.other_nodes;
        this.io = null;
        global.msg_queue = [];
        global.o_nodes = [];
        global.cluster_queue = {};
    }

    init(next) {
        try {
            // TODO probably need to make this https
            let server = require('http').createServer().listen(this.port, function () {});
            let node = this.node;
            this.io = require('socket.io').listen(server);
            this.io.sockets.on("connection", function (socket) {
                socket.on("identify", function (msg, callback) {
                    //this is the remote ip address of the client connecting to this server.
                    let raw_remote_ip = socket.conn.remoteAddress;
                    let raw_remote_ip_array = raw_remote_ip ? raw_remote_ip.split(':') : [];
                    msg.host = Array.isArray(raw_remote_ip_array) && raw_remote_ip_array.length > 0 ?  raw_remote_ip_array[raw_remote_ip_array.length - 1] : '';
                    let new_client = new SocketClient(node, msg);
                    new_client.client = socket;
                    new_client.createClientMessageHandlers();

                    let found_client = global.cluster_server.socket_client.filter((client)=>{
                        return client.other_node.name === msg.name;
                    });

                    // if we do not have a client connection for this other node we need to ask it for what we may have missed since last connection
                    let catchup_request = true;
                    for(let k = 0; k < node.other_nodes.length; k++){
                        if(node.other_nodes[k].name === msg.name){
                            socket.emit('catchup_request', {name: node.name});
                            return;
                        }
                    }

                    if(!found_client || found_client.length === 0){
                        global.cluster_server.socket_client.push(new_client);
                    }

                    socket.join(msg.name, () => {

                        harper_logger.info(node.name + ' joined room ' + msg.name);
                        // retrive the queue and send to this node.
                        fetchQueue(msg)

                    });
                });

                socket.on('catchup_request', (msg)=>{
                    harper_logger.info(msg.name + ' catchup_request');
                    cluster_handlers.fetchQueue(msg, socket);
                });



                socket.on('confirm_msg', function (msg) {
                    harper_logger.info(msg);
                    msg.type = 'cluster_response';
                    let queded_msg = global.forkClusterMsgQueue[msg.id];
                    if (queded_msg) {
                        for (let f in global.forks) {
                            if (global.forks[f].process.pid === queded_msg.pid) {
                                global.forks[f].send(msg);
                            }
                        }

                        // delete from memory
                        delete global.cluster_queue[msg.node.name][msg.id];
                        delete global.forkClusterMsgQueue[msg.id];
                        // delete from disk
                        let delete_obj = {
                            "table": "hdb_queue",
                            "schema": "system",
                            "hash_values": [msg.id]

                        };
                        harper_logger.info("delete_obj === " + JSON.stringify(delete_obj));
                        delete_.delete(delete_obj, function (err, result) {
                            if (err) {
                                harper_logger.error(err);
                            }
                        });

                    }


                });

                socket.on('error', function (error) {
                    harper_logger.error(error);
                });

                socket.on('disconnect', function (error) {
                    if (error !== 'transport close')
                        harper_logger.error(error);
                });

                socket.on('schema_update_request', function(error){
                    schema.describeAll({}, function(err, schema){
                        if(err){
                            return harper_logger.error(err);
                        }
                        socket.emit('schema_update_response', schema);
                    });
                });


            });

            next();

        } catch (e) {
            harper_logger.error(e);
            next(e);
        }
    }

}

function getFromDisk(node, callback) {
    let search_obj = {};
    search_obj.schema = 'system';
    search_obj.table = 'hdb_queue';
    search_obj.hash_attribute = 'id';
    search_obj.search_attribute = 'node_name';
    if (node)
        search_obj.search_value = node.name;
    else
        search_obj.search_value = "*";

    search_obj.get_attributes = ['*'];

    search.searchByValue(search_obj, function (err, data) {
        if (err) {
            return callback(err);
        }
        return callback(null, data);

    });
}

function authHeaderToUser(json_body, callback){
    let req = {};
    req.headers = {};
    req.headers.authorization = json_body.hdb_auth_header;

    auth.authorize(req, null, function (err, user) {
        if (err) {
            return callback(err);
        }

        json_body.hdb_user = user;

        callback(null, json_body);
    });
}

module.exports = SocketServer;