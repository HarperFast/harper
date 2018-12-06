const insert = require('../../data_layer/insert');
const node_Validator = require('../../validation/nodeValidator');
const hdb_utils = require('../../utility/common_utils');
const log = require('../../utility/logging/harper_logger');
const {promisify} = require('util');
const {inspect} = require('util');
const del = require('../../data_layer/delete');
const terms = require('../../utility/hdbTerms');
const env_mgr = require('../../utility/environment/environmentManager');
const os = require('os');

//Promisified functions
const p_insert_insert = promisify(insert.insert);
const p_delete_delete = promisify(del.delete);

const iface = os.networkInterfaces();
const addresses = [];

const DUPLICATE_ERR_MSG = 'Cannot add a node that matches the hosts clustering config.';

for (let k in iface) {
    for (let k2 in iface[k]) {
        let address = iface[k][k2];
        if (address.family === 'IPv4' && !address.internal) {
            addresses.push(address.address);
        }
    }
}

function addNode(new_node, callback) {
    // need to clean up new node as it hads operation and user on it
    let validation = node_Validator(new_node);
    let cluster_port = undefined;
    let new_port = undefined;
    try {
        // This should move up as a const once https://harperdb.atlassian.net/browse/HDB-640 is done.
        cluster_port = env_mgr.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_PORT_KEY);
        new_port = parseInt(new_node.port);
    } catch(err) {
        return callback(`Invalid port: ${new_node.port} specified`, null);
    }

    //TODO: We may need to expand this depending on what is decided in https://harperdb.atlassian.net/browse/HDB-638
    if(new_port === cluster_port) {
        if((new_node.host === 'localhost' || new_node.host === '127.0.0.1')) {
            return callback(DUPLICATE_ERR_MSG, null);
        }
        if(addresses && addresses.includes(new_node.host)) {
            return callback(DUPLICATE_ERR_MSG, null);
        }
        if(os.hostname() === new_node.host) {
            return callback(DUPLICATE_ERR_MSG, null);
        }
    }

    if(validation) {
        log.error(`Validation error in addNode validation. ${validation}`);
        return callback(validation);
    }

    let new_node_insert = {
        "operation":"insert",
        "schema":"system",
        "table":"hdb_nodes",
        "records": [new_node]
    };

    insert.insert(new_node_insert, function(err, results){
        if(err) {
            log.error(`Error adding new cluster node ${new_node_insert}.  ${err}`);
            return callback(err);
        }

        if(!hdb_utils.isEmptyOrZeroLength(results.skipped_hashes)){
            log.info(`Node '${new_node.name}' has already been already added. Operation aborted.`);
            return callback(null, `Node '${new_node.name}' has already been already added. Operation aborted.`);
        }

        // Send IPC message so master will command forks to rescan for new nodes.
        process.send({
            "type": "node_added"
        });
        return callback(null, `successfully added ${new_node.name} to manifest`);
    });
}

/**
 * A callback wrapper for removeNode.  This is needed to match the processLocalTransaction style currently used until we fully
 * migrate to async/await.  Once that migration is complete, this function can be removed and have it replaced in module.exports
 * with the async function.
 *
 * @param remove_node
 * @param callback
 * @returns {*}
 */
function removeNodeCB(remove_node, callback) {
    if(!remove_node) {
        return callback('Invalid JSON message for remove_node', null);
    }
    let response = {};
    removeNode(remove_node).then((result) => {
        response['message'] = result;
        return callback(null, response);
    }).catch((err) => {
        log.error(`There was an error removing node ${err}`);
        return callback(err, null);
    });
}

/**
 * Remove a node from hdb_nodes.
 * @param remove_json_message - The remove_node json message.
 * @returns {Promise<string>}
 */
async function removeNode(remove_json_message) {
    if(!remove_json_message.name) {
        let err_msg = `Missing node name in remove_node`;
        log.error(err_msg);
        throw new Error(err_msg);
    }

    let delete_obj = {
        "table": terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME,
        "schema": terms.SYSTEM_SCHEMA_NAME,
        "hash_values": [remove_json_message.name]
    };

    let results = undefined;
    try {
        results = await p_delete_delete(delete_obj);
    } catch(err) {
        log.error(`Error removing cluster node ${inspect(delete_obj)}.  ${err}`);
        throw err;
    }
    if(!hdb_utils.isEmptyOrZeroLength(results.skipped_hashes)) {
        log.info(`Node '${remove_json_message.name}' was not found. Operation aborted.`);
        return `Node '${remove_json_message.name}' was not found.`;
    }

    // Send IPC message so master will command forks to rescan for new nodes.
    process.send({
        "type": "node_added"
    });
    return `successfully removed ${remove_json_message.name} from manifest`;
}

function payloadHandler(msg) {
    if(hdb_utils.isEmptyOrZeroLength(global.cluster_server)) {
        log.error(`Cannot send cluster updates, cluster server is not initialized.`);
        return;
    }
    switch(msg.clustering_type) {
        case "broadcast":
            log.info(`broadcasting cluster message`);
            global.cluster_server.broadCast(msg);
            break;
        case "send":
            log.info('sending cluster message');
            global.cluster_server.send(msg, msg.res);
    break;
    }
}

/**
 * A callback wrapper for configureCluster.  This is needed to match the processLocalTransaction style currently used until we fully
 * migrate to async/await.  Once that migration is complete, this function can be removed and have it replaced in module.exports
 * with the async function.
 *
 * @param enable_cluster_json - The json message containing the port, node name, enabled to use to enable clustering
 * @param callback
 * @returns {*}
 */
function configureClusterCB(enable_cluster_json, callback) {
    if(!enable_cluster_json) {
        return callback('Invalid JSON message for remove_node', null);
    }
    let response = {};
    configureCluster(enable_cluster_json).then((result) => {
        response['message'] = 'Successfully wrote clustering config settings.';
        return callback(null, response);
    }).catch((err) => {
        log.error(`There was an error removing node ${err}`);
        return callback(err, null);
    });
}

/**
 * Configure clustering by updating the config settings file with the specified paramters in the message, and then
 * start or stop clustering depending on the enabled value.
 * @param enable_cluster_json
 * @returns {Promise<void>}
 */
async function configureCluster(enable_cluster_json) {
    if(hdb_utils.isEmptyOrZeroLength(enable_cluster_json) || hdb_utils.isEmptyOrZeroLength(enable_cluster_json.clustering_port) || hdb_utils.isEmptyOrZeroLength(enable_cluster_json.clustering_node_name)) {
        throw new Error(`Invalid port: ${enable_cluster_json.clustering_port} or hostname: ${enable_cluster_json.clustering_node_name} specified in enableCluster.`);
    }
    try {
        env_mgr.setProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY, enable_cluster_json.enabled);
        env_mgr.setProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_PORT_KEY, enable_cluster_json.clustering_port);
        env_mgr.setProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY, enable_cluster_json.clustering_node_name);
        await env_mgr.writeSettingsFile(true);
    } catch(err) {
        log.error(err);
        throw err;
    }
}

function clusterMessageHandler(msg) {
    try {
        if (msg.type === 'clustering_payload') {
            global.forkClusterMsgQueue[msg.id] = msg;
            payloadHandler(msg);
        } else if (msg.type === 'delegate_thread_response') {
            global.delegate_callback_queue[msg.id](msg.err, msg.data);
        } else if (msg.type === 'clustering') {
            global.clustering_on = true;
            global.forks.forEach((fork) => {
                fork.send(msg);
            });
        } else if (msg.type === 'schema') {
            global.forks.forEach((fork) => {
                fork.send(msg);
            });
        } else if (!hdb_utils.isEmptyOrZeroLength(msg.target_process_id)) {
            // If a process is specified in the message, send this job to that process.
            let backup_process = undefined;
            let specified_process = undefined;
            for (let i = 0; i < global.forks.length; i++) {
                if (!backup_process && global.forks[i].process.pid !== msg.target_process_id) {
                    // Set a backup process to send the message to in case we don't find the specified process.
                    backup_process = global.forks[i];
                }
                if (global.forks[i].process.pid === msg.target_process_id) {
                    specified_process = global.forks[i];
                    specified_process.send(msg);
                    log.info(`Processing job on process: ${msg.target_process_id}`);
                    break;
                }
            }
            if (!specified_process && backup_process) {
                log.info(`The specified process ${msg.target_process_id} was not found, sending to default process instead.`);
                backup_process.send(msg);
            }
        } else if (msg.type === 'node_added') {
            if(hdb_utils.isEmptyOrZeroLength(global.cluster_server)) {
                log.error('Cluster Server has not been initialized.  Do you have CLUSTERING=true in your config/settings file?');
                return;
            }
            global.cluster_server.scanNodes().then( () => {
                log.info('Done scanning for new cluster nodes');
            }).catch( (e) => {
                log.error('There was an error scanning for new cluster nodes');
                log.error(e);
            });
        } else if (msg.type === 'node_removed') {
            if(hdb_utils.isEmptyOrZeroLength(global.cluster_server)) {
                log.error('Cluster Server has not been initialized.  Do you have CLUSTERING=true in your config/settings file?');
                return;
            }
            global.cluster_server.scanNodes().then( () => {
                log.info('Done scanning for removed cluster nodes');
            }).catch( (e) => {
                log.error('There was an error scanning for removed cluster nodes');
                log.error(e);
            });
        }
    } catch (e) {
        log.error(e);
    }
}

module.exports = {
    addNode: addNode,
    // The reference to the callback functions can be removed once processLocalTransaction has been refactored
    configureCluster: configureClusterCB,
    removeNode: removeNodeCB,
    payloadHandler: payloadHandler,
    clusterMessageHandler: clusterMessageHandler
};