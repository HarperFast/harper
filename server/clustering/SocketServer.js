"use strict";

const log = require('../../utility/logging/harper_logger');
const search = require('../../data_layer/search');
const insert = require('../../data_layer/insert');
const delete_ = require('../../data_layer/delete');
const schema = require('../../data_layer/schema');
const uuidv4 = require('uuid/v1');
const http = require('http');
const https = require('https');
const sio = require('socket.io');
const {promisify} = require('util');
const fs = require('fs');
const terms = require('../../utility/hdbTerms');

const PropertiesReader = require('properties-reader');
let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));

const privateKeyPath = hdb_properties.get(terms.HDB_SETTINGS_NAMES.PRIVATE_KEY);
const certificatePath = hdb_properties.get(terms.HDB_SETTINGS_NAMES.CERTIFICATE);

let credentials = undefined;
try {
    credentials = {key: fs.readFileSync(`${privateKeyPath}`), cert: fs.readFileSync(`${certificatePath}`)};
} catch(err) {
    log.error('Error reading https private key and credential files');
    credentials = undefined;
}

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
            let server = undefined;
            if(!credentials) {
                server = http.createServer().listen(this.port, function () {
                });
            } else {
                server = https.createServer(credentials, () => {

                }).listen(this.port);
            }
            let node = this.node;
            this.io = sio.listen(server);
            this.io.sockets.on("connection", function (socket) {
                socket.on("identify", function (msg, callback) {
                    //this is the remote ip address of the client connecting to this server.
                    let raw_remote_ip = socket.conn.remoteAddress;
                    let raw_remote_ip_array = raw_remote_ip ? raw_remote_ip.split(':') : [];
                    msg.host = Array.isArray(raw_remote_ip_array) && raw_remote_ip_array.length > 0 ?  raw_remote_ip_array[raw_remote_ip_array.length - 1] : '';

                    global.cluster_server.establishConnection(msg);
                    socket.join(msg.name, () => {

                        log.info(node.name + ' joined room ' + msg.name);
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
                                log.info('sent msg');
                                log.info(global.cluster_queue[msg.name]);

                                let catchup_payload = JSON.stringify(global.cluster_queue[msg.name]);
                                socket.emit('catchup', catchup_payload);
                            }
                        });
                    });
                });


                socket.on('confirm_msg', function (msg) {
                    log.info(msg);
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
                        log.info("delete_obj === " + JSON.stringify(delete_obj));
                        delete_.delete(delete_obj, function (err, result) {
                            if (err) {
                                log.error(err);
                            }
                        });

                    }


                });

                socket.on("msg", function (msg) {
                    log.info(`${this.node.name} says ${msg}`);
                });

                socket.on('error', function (error) {
                    log.error(error);
                });

                socket.on('disconnect', function (error) {
                    if (error !== 'transport close')
                        log.error(error);
                });

                socket.on('schema_update_request', function(error){
                    schema.describeAll({}, function(err, schema){
                        if(err){
                            return log.error(err);
                        }
                        socket.emit('schema_update_response', schema);
                    });
                });


            });

            next();

        } catch (e) {
            log.error(e);
            next(e);
        }
    }

    send(msg) {

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
            log.error(e);
        }
    }

}

function saveToDisk(item, callback) {
    try {
        let insert_object = {
            operation: 'insert',
            schema: 'system',
            table: 'hdb_queue',
            records: [item]
        };

        insert.insert(insert_object, function (err, result) {
            if (err) {
                log.error(err);
                return callback(err);
            }
            callback(null, result);


        });
    } catch (e) {
        log.error(e);
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
};

module.exports = SocketServer;