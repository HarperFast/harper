const insert = require('../../data_layer/insert');
const node_Validator = require('../../validation/nodeValidator');
const hdb_utils = require('../../utility/common_utils');
const log = require('../../utility/logging/harper_logger');

function addNode(new_node, callback){
    // need to clean up new node as it hads operation and user on it
    let validation = node_Validator(new_node);
    if(validation) {
        log.error(`Validation error in addNode validation. ${validation}`);
        return callback(validation);
    }

    let new_node_insert = {
        "operation":"insert",
        "schema":"system",
        "table":"hdb_nodes",
        "records": [new_node]
    }

    insert.insert(new_node_insert, function(err, results){
        if(err) {
            log.error(`Error adding new cluster node ${new_node_insert}.  ${err}`);
            return callback(err);
        }

        if(!hdb_utils.isEmptyOrZeroLength(results.skipped_hashes)){
            log.info(`Node '${new_node.name}' has already been already added. Operation aborted.`);
            return callback(null, `Node '${new_node.name}' has already been already added. Operation aborted.`)
        }

        // Send IPC message so master will command forks to rescan for new nodes.
        process.send({
            "type": "node_added"
        });
        return callback(null, `successfully added ${new_node.name} to manifest`);
    });
}

function payloadHandler(msg){
    if(hdb_utils.isEmptyOrZeroLength(global.cluster_server)) {
        log.error(`Cannot send cluster updates, cluster server is not initialized.`);
        return;
    }
    switch(msg.clustering_type){
        case "broadcast":
            log.info(`broadcasting cluster message`);
            global.cluster_server.broadCast(msg);
            break;
        case "send":
            log.info('sending cluster message')
            global.cluster_server.send(msg, msg.res);
    break;
    }
};

function clusterMessageHandler(msg) {
    try {
        if (msg.type === 'clustering_payload') {
            global.forkClusterMsgQueue[msg.id] = msg;
            payloadHandler(msg);
        } else if (msg.type === 'delegate_thread_response') {
            global.delegate_callback_queue[msg.id](msg.err, msg.data);
        }else if (msg.type === 'clustering') {
            global.clustering_on = true;
            global.forks.forEach((fork) => {
                fork.send(msg);
            });
        }else if (msg.type === 'schema') {
            global.forks.forEach((fork) => {
                fork.send(msg);
            });
        }else if (!hdb_utils.isEmptyOrZeroLength(msg.target_process_id)) {
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
                log.info(`The specified process ${msg.target_process_id} was not found, sending to process ${global.forks[i].pid} instead.`);
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
        }
    } catch (e) {
        log.error(e);
    }
}

module.exports = {
        addNode: addNode,
        payloadHandler: payloadHandler,
        clusterMessageHandler: clusterMessageHandler
}