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

    insert.insert(new_node_insert, function(err){
        if(err) {
            log.error(`Error adding new cluster node ${new_node_insert}.  ${err}`);
            return callback(err);
        }
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

module.exports = {
        addNode: addNode,
        payloadHandler: payloadHandler
}