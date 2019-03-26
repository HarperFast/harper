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
const configure_validator = require('../../validation/clustering/configureValidator');
const auth = require('../../security/auth');
const ClusterStatusObject = require('../../server/clustering/ClusterStatusObject');
const signalling = require('../../utility/signalling');
const cluster_status_event = require('../../events/ClusterStatusEmitter');

//Promisified functions
const p_delete_delete = promisify(del.delete);
const p_auth_authorize = promisify(auth.authorize);

const iface = os.networkInterfaces();
const addresses = [];
const started_forks = {};
let is_enterprise = false;

const STATUS_TIMEOUT_MS = 2000;

const DUPLICATE_ERR_MSG = 'Cannot add a node that matches the hosts clustering config.';

for (let k in iface) {
    for (let k2 in iface[k]) {
        let address = iface[k][k2];
        if (address.family === 'IPv4' && !address.internal) {
            addresses.push(address.address);
        }
    }
}

function setEnterprise(enterprise) {
    is_enterprise = enterprise;
}

async function kickOffEnterprise() {
    const enterprise_util = require('../../utility/enterpriseInitialization');
    const p_kick_off_enterprise = promisify(enterprise_util.kickOffEnterprise);

    global.forks.forEach((fork) => {
        fork.send({"type": "enterprise", "enterprise": is_enterprise});
    });

    let enterprise_msg = await p_kick_off_enterprise();
    if (enterprise_msg.clustering) {
        global.clustering_on = true;
        global.forks.forEach((fork) => {
            fork.send({"type": "clustering"});
        });
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

    insert.insertCB(new_node_insert, function(err, results){
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
            "type": terms.CLUSTER_MESSAGE_TYPE_ENUM.NODE_ADDED,
            "node_name": new_node.name
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
        "type": terms.CLUSTER_MESSAGE_TYPE_ENUM.NODE_REMOVED,
        "node_name": remove_json_message.name
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
    configureCluster(enable_cluster_json).then(() => {
        response['message'] = 'Successfully wrote clustering config settings.  A backup file was created.';
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
    let validation = configure_validator(enable_cluster_json);
    if(validation) {
        log.error(`Validation error in configureCluster validation. ${validation}`);
        throw new Error(validation);
    }
    try {
        env_mgr.setProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY, enable_cluster_json.clustering_enabled);
        env_mgr.setProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_PORT_KEY, enable_cluster_json.clustering_port);
        env_mgr.setProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY, enable_cluster_json.clustering_node_name);
        await env_mgr.writeSettingsFileSync(true);
    } catch(err) {
        log.error(err);
        throw err;
    }
}

/**
 * A callback wrapper for clusterStatusCB.  This is needed to match the processLocalTransaction style currently used until we fully
 * migrate to async/await.  Once that migration is complete, this function can be removed and have it replaced in module.exports
 * with the async function.
 *
 * @param cluster_status_json - The json message containing the port, node name, enabled to use to enable clustering
 * @param callback
 * @returns {*}
 */
function clusterStatusCB(cluster_status_json, callback) {
    if(!cluster_status_json) {
        return callback('Invalid JSON message for remove_node', null);
    }
    let response = {};
    clusterStatus(cluster_status_json).then((result) => {
        response = result;
        return callback(null, response);
    }).catch((err) => {
        log.error(`There was an error getting cluster status ${err}`);
        return callback(err, null);
    });
}

/**
 * Get the status of this hosts clustering configuration and connections.
 * @param enable_cluster_json
 * @returns {Promise<void>}
 */
async function clusterStatus(cluster_status_json) {
    let response = {};
    try {
        let clustering_enabled = env_mgr.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY);
        response["is_enabled"] = clustering_enabled;
        if (!clustering_enabled) {
            return response;
        }
        // we only have 1 process, call get status directly
        if (process.send === undefined) {
            response["status"] = JSON.stringify(getClusterStatus());
            return response;
        }

        // If we have more than 1 process, we need to get the status from the master process which has that info stored
        // in global.  We subscribe to an event that master will emit once it has gathered the data.  We want to build
        // in a timeout in case the event never comes.
        const timeout_promise = hdb_utils.timeoutPromise(STATUS_TIMEOUT_MS, 'Timeout trying to get cluster status.');
        const event_promise = new Promise((resolve) => {
            cluster_status_event.clusterEmitter.on(cluster_status_event.EVENT_NAME, (msg) => {
                log.info(`Got cluster status event response: ${inspect(msg)}`);
                try {
                    timeout_promise.cancel();
                } catch(err) {
                    log.error('Error trying to cancel timeout.');
                }
                resolve(msg);
            });
        });

        // send a signal to master to gather cluster data.
        signalling.signalClusterStatus();
        // use race to incorporate the timeout.  There is no way to cancel the event_promise, but at least we can
        // keep this code from waiting indefinitely.
        response["status"] = await Promise.race([event_promise, timeout_promise.promise]);
    } catch(err) {
        log.error(`Got an error getting cluster status ${err}`);
    }
    return response;
}

/**
 * Decide which process to send response to.  If parameter is null, a random process will be selected.
 * @param target_process_id
 */
function selectProcess(target_process_id) {
    let backup_process = undefined;
    let specified_process = undefined;
    for (let i = 0; i < global.forks.length; i++) {
        if (!backup_process && global.forks[i].process.pid !== target_process_id) {
            // Set a backup process to send the message to in case we don't find the specified process.
            backup_process = global.forks[i];
        }
        if (global.forks[i].process.pid === target_process_id) {
            specified_process = global.forks[i];
            //specified_process.send(msg);
            log.info(`Processing job on process: ${target_process_id}`);
            return specified_process;
        }
    }
    if (!specified_process && backup_process) {
        log.info(`The specified process ${target_process_id} was not found, sending to default process instead.`);
        return backup_process;
    }
}

/**
 * This will build and populate a ClusterStatusObject and send it back to the process that requested it.
 */
function getClusterStatus() {
    log.debug('getting cluster status.');
    if(!global.cluster_server) {
        log.error(`Tried to get cluster status, but the cluster is not initialized.`);
        throw new Error(`Tried to get cluster status, but the cluster is not initialized.`);
    }
    let status_obj = new ClusterStatusObject.ClusterStatusObject();
    try {
        status_obj.my_node_port = global.cluster_server.socket_server.port;
        status_obj.my_node_name = global.cluster_server.socket_server.name;
        log.debug(`There are ${global.cluster_server.socket_client.length} socket clients.`);
        for (let conn of global.cluster_server.socket_client) {
            let new_status = new ClusterStatusObject.ConnectionStatus();
            new_status.direction = conn.direction;
            if (conn.other_node) {
                new_status.host = conn.other_node.host;
                new_status.port = conn.other_node.port;
            }
            let status = conn.client.connected;
            new_status.connection_status = (status ? ClusterStatusObject.CONNECTION_STATUS_ENUM.CONNECTED :
                ClusterStatusObject.CONNECTION_STATUS_ENUM.DISCONNECTED);

            switch (conn.direction) {
                case terms.CLUSTER_CONNECTION_DIRECTION_ENUM.INBOUND:
                    status_obj.inbound_connections.push(new_status);
                    break;
                case terms.CLUSTER_CONNECTION_DIRECTION_ENUM.OUTBOUND:
                    status_obj.outbound_connections.push(new_status);
                    break;
                case terms.CLUSTER_CONNECTION_DIRECTION_ENUM.BIDIRECTIONAL:
                    status_obj.bidirectional_connections.push(new_status);
                    break;
            }
        }
    } catch(err) {
        log.error(err);
    }
    return status_obj;
}

/**
 * This function describes messages the master process expects to recieve from child processes.
 * @param msg
 */
function clusterMessageHandler(msg) {
    try {
        switch(msg.type) {
            case terms.CLUSTER_MESSAGE_TYPE_ENUM.CLUSTERING_PAYLOAD:
                global.forkClusterMsgQueue[msg.id] = msg;
                payloadHandler(msg);
                break;
            case terms.CLUSTER_MESSAGE_TYPE_ENUM.DELEGATE_THREAD_RESPONSE:
                global.delegate_callback_queue[msg.id](msg.err, msg.data);
                break;
            case terms.CLUSTER_MESSAGE_TYPE_ENUM.CLUSTERING:
                global.clustering_on = true;
                global.forks.forEach((fork) => {
                    fork.send(msg);
                });
                break;
            case terms.CLUSTER_MESSAGE_TYPE_ENUM.SCHEMA:
                global.forks.forEach((fork) => {
                    fork.send(msg);
                });
                break;
            case terms.CLUSTER_MESSAGE_TYPE_ENUM.USER:
                global.forks.forEach((fork) => {
                    fork.send(msg);
                });
                break;
            case terms.CLUSTER_MESSAGE_TYPE_ENUM.NODE_ADDED:
                if(hdb_utils.isEmptyOrZeroLength(global.cluster_server)) {
                    log.error('Cluster Server has not been initialized.  Do you have CLUSTERING=true in your config/settings file?');
                    return;
                }
                global.cluster_server.nodeAdded(msg.node_name);
                global.cluster_server.scanNodes().then( () => {
                    log.info('Done scanning for new cluster nodes');
                }).catch( (e) => {
                    log.error('There was an error scanning for new cluster nodes');
                    log.error(e);
                });
                break;
            case terms.CLUSTER_MESSAGE_TYPE_ENUM.NODE_REMOVED:
                if(hdb_utils.isEmptyOrZeroLength(global.cluster_server)) {
                    log.error('Cluster Server has not been initialized.  Do you have CLUSTERING=true in your config/settings file?');
                    return;
                }
                let name = msg.node_name;
                global.cluster_server.nodeRemoved(msg.node_name);
                global.cluster_server.scanNodes().then( () => {
                    log.info('Done scanning for removed cluster nodes');
                }).catch( (e) => {
                    log.error('There was an error scanning for removed cluster nodes');
                    log.error(e);
                });
                break;
            case terms.CLUSTER_MESSAGE_TYPE_ENUM.CLUSTER_STATUS:
                let status = undefined;
                let target_process = undefined;
                try {
                    target_process = selectProcess(msg.target_process_id);
                    status = getClusterStatus();
                } catch (err) {
                    log.error(err);
                    status = err.message;
                }
                if(!target_process) {
                    log.error(`Failed to select a process to respond to with cluster status.`);
                    target_process = global.forks[0];
                }
                msg["cluster_status"] = status;
                target_process.process.send({"type": terms.CLUSTER_MESSAGE_TYPE_ENUM.CLUSTER_STATUS, "status": status});
                break;
            case terms.CLUSTER_MESSAGE_TYPE_ENUM.JOB:
                if (!hdb_utils.isEmptyOrZeroLength(msg.target_process_id)) {
                    // If a process is specified in the message, send this job to that process.
                    let target_process = selectProcess(msg.target_process_id);
                    if(!target_process) {
                        log.error(`Failed to select a process to send job message to.`);
                        return;
                    }
                    target_process.send(msg);
                }
                break;
            case terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STARTED:
                log.info('Received child started event.');
                if(started_forks[msg.pid]) {
                    log.warn(`Got a duplicate child started event for pid ${msg.pid}`);
                } else {
                    started_forks[msg.pid] = true;
                    if(Object.keys(started_forks).length === global.forks.length) {
                        //all children are started, kick off enterprise.
                        kickOffEnterprise();
                    }
                }
                break;
            default:
                log.error(`Got an unhandled cluster message type ${msg.type}`);
                break;
        }
    } catch (e) {
        log.error(e);
    }
}

async function authHeaderToUser(json_body){
    let req = {};
    req.headers = {};
    req.headers.authorization = json_body.hdb_auth_header;

    let user = await p_auth_authorize(req, null)
        .catch((e)=>{
            throw e;
        });
    json_body.hdb_user = user;
    return json_body;
}

module.exports = {
    addNode: addNode,
    // The reference to the callback functions can be removed once processLocalTransaction has been refactored
    configureCluster: configureClusterCB,
    clusterStatus: clusterStatusCB,
    removeNode: removeNodeCB,
    payloadHandler: payloadHandler,
    clusterMessageHandler: clusterMessageHandler,
    authHeaderToUser: authHeaderToUser,
    setEnterprise: setEnterprise
};