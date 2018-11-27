"use strict";

const harper_logger = require('../../utility/logging/harper_logger');
const search = require('../../data_layer/search');
const insert = require('../../data_layer/insert');
const delete_ = require('../../data_layer/delete');
const schema = require('../../data_layer/schema');
const server_utilities = require('../serverUtilities');
const auth = require('../../security/auth');
const uuidv4 = require('uuid/v1');
const SocketClient = require('./SocketClient');

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
//todo check for pre-existing socket_client with same name
                    global.cluster_server.socket_client.push(new_client);

                    socket.join(msg.name, () => {

                        harper_logger.info(node.name + ' joined room ' + msg.name);
                        // retrive the queue and send to this node.

                        getFromDisk({"name": msg.name}, function (err, disk_catch_up) {
                            if (disk_catch_up && disk_catch_up.length > 0) {
                                if (!global.cluster_queue[msg.name]) {
                                    global.cluster_queue[msg.name] = {};
                                }

                                for (let item in disk_catch_up) {
                                    if (!global.cluster_queue[msg.name][disk_catch_up[item].id]) {
                                        global.forkClusterMsgQueue[disk_catch_up[item].id] = disk_catch_up[item].payload;
                                        global.cluster_queue[msg.name][disk_catch_up[item].id] = disk_catch_up[item].payload;
                                    }

                                }
                            }

                            socket.emit('confirm_identity');

                            if (global.cluster_queue && global.cluster_queue[msg.name]) {
                                harper_logger.info('sent msg');
                                harper_logger.info(global.cluster_queue[msg.name]);

                                let catchup_payload = JSON.stringify(global.cluster_queue[msg.name]);
                                socket.emit('catchup', catchup_payload);
                            }
                        });
                    });
                });

//move to SocketCLient
                /*socket.on('confirm_msg', function (msg) {
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


                });*/

                socket.on("msg", (msg) => {
                    harper_logger.info(`received by ${this.name} : msg = ${JSON.stringify(msg)}`);
                    let the_client = socket;
                    let this_node = this.node;
                    authHeaderToUser(msg.body, (error) => {
                        if (error) {
                            return harper_logger.error(error);
                        }

                        if (!msg.body.hdb_user) {
                            harper_logger.info('there is no hdb_user: ' + JSON.stringify(msg.body));
                        }

                        server_utilities.chooseOperation(msg.body, (err, operation_function) => {
                            server_utilities.proccessDelegatedTransaction(msg.body, operation_function, function (err, data) {
                                let payload = {
                                    "id": msg.id,
                                    "error": err,
                                    "data": data,
                                    "node": this_node
                                };
                                the_client.emit('confirm_msg', payload);
                            });
                        });
                    });
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

    //move to SocketClient
    /*send(msg) {

        try {
            delete msg.body.hdb_user;
            if (!msg.id)
                msg.id = uuidv4();

            let payload = {"body": msg.body, "id": msg.id};

            if (!global.cluster_queue[msg.node.name]) {
                global.cluster_queue[msg.node.name] = {};
            }
            global.cluster_queue[msg.node.name][payload.id] = payload;
            //kyle...this needs to be a var not a let ....
            var this_io = this.io;
            saveToDisk({
                "payload": payload,
                "id": payload.id,
                "node": msg.node,
                "node_name": msg.node.name
            }, function (err, result) {
                if (err) {
                    return err;
                }

                this_io.to(msg.node.name).emit('msg', payload);


            });


        } catch (e) {
            //save the queue to disk for all nodes.
            harper_logger.error(e);
        }
    }*/

}
//move to SocketCLient
/*function saveToDisk(item, callback) {
    try {
        let insert_object = {
            operation: 'insert',
            schema: 'system',
            table: 'hdb_queue',
            records: [item]
        };

        insert.insert(insert_object, function (err, result) {
            if (err) {
                harper_logger.error(err);
                return callback(err);
            }
            callback(null, result);


        });
    } catch (e) {
        harper_logger.error(e);
    }
}*/

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