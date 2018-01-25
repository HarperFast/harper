const
    winston = require('../../utility/logging/winston_logger'),
    search = require('../../data_layer/search'),
    insert = require('../../data_layer/insert'),
    delete_ = require('../../data_layer/delete');

class Socket_Server {
    constructor(node) {
        this.node = node;
        this.name = node.name;
        this.port = node.port;
        this.other_nodes = node.other_nodes;
        global.msg_queue = [];
        global.o_nodes = [];
        global.cluster_queue = [];


    }


    init(next) {
        try {




            // TODO probably need to make this https
            var server = require('http').createServer().listen(this.port, function () {
            });

            let node = this.node;
            this.io = require('socket.io').listen(server);

            this.io.sockets.on("connection", function (socket) {


                socket.on("identify", function (msg, callback) {
                    socket.join(msg, () => {

                        winston.info(node.name + ' joined room ' + msg);
                        // retrive the queue and send to this node.

                        getFromDisk({"name": msg}, function (err, disk_catch_up) {
                            if (disk_catch_up && disk_catch_up.length > 0) {
                                if (!global.cluster_queue[msg]) {
                                    global.cluster_queue[msg] = {};
                                }

                                for (let item in disk_catch_up) {
                                    if (!global.cluster_queue[msg][disk_catch_up[item].id]) {
                                        global.cluster_queue[msg][disk_catch_up[item].id] = disk_catch_up[item].payload;
                                    }

                                }
                            }


                            socket.emit('confirm_identity');

                            if (global.cluster_queue
                                && global.cluster_queue[msg]) {
                                winston.info('sent msg');
                                winston.info(global.cluster_queue[msg]);

                                let catchup_payload = JSON.stringify(global.cluster_queue[msg]);
                                socket.emit('catchup', catchup_payload);


                            }

                        });
                    });


                    // callback( msg );
                });


                socket.on('confirm_msg', function (msg) {
                    winston.info(msg);

                    msg.type = 'cluster_response';
                    let queded_msg = global.forkClusterMsgQueue[msg.id];
                    for (let f in global.forks) {
                        if (global.forks[f].process.pid === queded_msg.pid) {
                            global.forks[f].send(msg);
                        }
                    }

                    // delete from memory
                    delete global.cluster_queue[msg.node.name][msg.id];
                    // delete from disk
                    delete_obj = {
                        "table":"hdb_queue",
                        "schema":"system",
                        "hash_values":[msg.id]

                    }

                    delete_.delete(delete_obj, function(err, result){
                       if(err){
                           winston.error(err);
                       }
                    });



                });

                socket.on("msg", function (msg, callback) {

                    winston.info(`${this_node.name} says ${msg}`);
                    //callback( msg );
                });


                socket.on('error', function (error) {
                    winston.error(error);
                });

                socket.on('disconnect', function (error) {
                    if (error != 'transport close')
                        winston.error(error);

                });


            });

            next();

        } catch (e) {
            winston.error(e);
            next(e);
        }
    }

    send(msg) {
        //console.trace('msg in send:' + JSON.stringify(msg));

        try {
            let payload = {"body": msg.body, "id": msg.id};


            if (!global.cluster_queue[msg.node.name]) {
                global.cluster_queue[msg.node.name] = {};
            }
            global.cluster_queue[msg.node.name][payload.id] = payload;

            this.io.to(msg.node.name).emit('msg', payload)


            if (!global.o_nodes[msg.node.name] ||
                !global.o_nodes[msg.node.name].status ||
                !global.o_nodes[msg.node.name].status != 'connected') {
                saveToDisk({"payload": payload, "id": payload.id, "node": msg.node, "node_name": msg.node.name});

            }


        } catch (e) {
            //save the queue to disk for all nodes.
            winston.error(e);
        }
    }

}

function saveToDisk(item) {

    let insert_object = {
        operation: 'insert',
        schema: 'system',
        table: 'hdb_queue',
        records: [item]
    };

    insert.insert(insert_object, function (err) {
        if (err) {
            return winston.error(err);
        }
    });

}

function getFromDisk(node, callback) {
    var search_obj = {};
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


module.exports = Socket_Server;
