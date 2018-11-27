const harper_logger = require('../../utility/logging/harper_logger');
const auth = require('../../security/auth');
const server_utilities = require('../serverUtilities');
const search = require('../../data_layer/search');
const delete_ = require('../../data_layer/delete');

module.exports = {
    fetchQueue: fetchQueue,
    onConfirmMessageHandler: onConfirmMessageHandler
};


function fetchQueue(msg, socket){
    let the_socket = socket;
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
            the_socket.emit('catchup', catchup_payload);
        }
    });
}

function onConfirmMessageHandler(msg){
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