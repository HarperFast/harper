const harper_logger = require('../../utility/logging/harper_logger');
const search = require('../../data_layer/search');
const delete_ = require('../../data_layer/delete');
const schema = require('../../data_layer/schema');
const {promisify} = require('util');
const clone = require('clone');
const insert = require('../../data_layer/insert');
const terms = require('../../utility/hdbTerms');
const SQL_Search_Object = require('../../data_layer/SqlSearchObject');
const hdb_sql = require('../../sqlTranslator/index');

const p_search_by_value = promisify(search.searchByValue);
const p_delete = promisify(delete_.delete);
const p_schema_describe_all = promisify(schema.describeAll);
const p_insert = promisify(insert.insert);

module.exports = {
    fetchQueue: fetchQueue,
    onConfirmMessageHandler: onConfirmMessageHandler,
    addToHDBQueue: addToHDBQueue
};

async function fetchQueue(msg, socket){
    try {
        let the_socket = socket;

        let disk_catch_up = await getFromDisk({"name": msg.name});

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
        let schema_describe = await p_schema_describe_all({});
        let node_payload = {
            schema: schema_describe
        };

        if (global.cluster_queue && global.cluster_queue[msg.name]) {
            harper_logger.info('sent msg');
            harper_logger.info(global.cluster_queue[msg.name]);

            node_payload.queue = global.cluster_queue[msg.name];
        }

        //let catchup_payload = JSON.stringify(node_payload);
        the_socket.emit('catchup', node_payload);
    } catch(e){
        harper_logger.error(e);
    }
}

async function onConfirmMessageHandler(msg){
    try {
        harper_logger.info(msg);
        msg.type = 'cluster_response';
        let queded_msg = global.forkClusterMsgQueue[msg.id];
        if (!queded_msg) {
            return;
        }

        for (let f in global.forks) {
            if (global.forks[f].process.pid === queded_msg.pid) {
                global.forks[f].send(msg);
            }
        }
    } catch(e) {
        harper_logger.error(e);
    }
    try {
        // delete from memory, this is OK if this fails.
        delete global.cluster_queue[msg.node.name][msg.id];
        delete global.forkClusterMsgQueue[msg.id];
    } catch(e){
        // No-op, This failure is OK
    }

    // delete from disk
    let delete_obj = {
        "table": "hdb_queue",
        "schema": "system",
        "hash_values": [msg.id]
    };
    harper_logger.info("delete from queue: " + JSON.stringify(delete_obj));
    await p_delete(delete_obj).catch((err) => {
        harper_logger.error(`Got an error deleting a confirmed message from hdb_queue.`);
        harper_logger.error(err);
    });
}

/**
 * Performs a search against hdb_queue by node name to get any pending messages meant for that node.  Sort by timestamp.
 * @param node
 * @returns {Promise<*>}
 */
async function getFromDisk(node) {
    let search_obj = {};

    search_obj.schema = 'system';
    search_obj.table = 'hdb_queue';
    search_obj.hash_attribute = 'id';
    search_obj.search_attribute = 'node_name';
    if (node) {
        search_obj.search_value = node.name;
    } else {
        search_obj.search_value = "*";
    }

    search_obj.get_attributes = ['*'];

    let data = await p_search_by_value(search_obj);
    try {
        if (data && data.length > 0) {
            data.sort(compare);
        }
    } catch(err) {
        harper_logger.error(err);
    }
    return data;
}

/**
 * Comparator function for sorting by timestamp.
 * @param a
 * @param b
 * @returns {number}
 */
function compare(a,b) {
    if (a.timestamp < b.timestamp)
        return -1;
    if (a.timestamp > b.timestamp)
        return 1;
    return 0;
}

async function addToHDBQueue(item) {
    try {
        let insert_object = {
            operation: 'insert',
            schema: 'system',
            table: 'hdb_queue',
            records: [item]
        };

        let results = await p_insert(insert_object);

        return results;
    } catch (e) {
        harper_logger.error(e);
    }
}
