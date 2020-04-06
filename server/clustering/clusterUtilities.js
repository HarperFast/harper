const insert = require('../../data_layer/insert');
const node_validator = require('../../validation/nodeValidator');
const node_subscription_validator = require('../../validation/nodeSubscriptionValidator');
const hdb_utils = require('../../utility/common_utils');
const log = require('../../utility/logging/harper_logger');
const util = require('util');
const del = require('../../data_layer/delete');
const terms = require('../../utility/hdbTerms');
const env_mgr = require('../../utility/environment/environmentManager');
const os = require('os');
const configure_validator = require('../../validation/clustering/configureValidator');
const auth = require('../../security/auth');
const ClusterStatusObject = require('../../server/clustering/ClusterStatusObject');
const cluster_status_event = require('../../events/ClusterStatusEmitter');
const children_stopped_event = require('../../events/AllChildrenStoppedEvent');
const child_process = require('child_process');
const path = require('path');
const InsertObject = require('../../data_layer/DataLayerObjects').InsertObject;
const search = require('../../data_layer/search');
const hdb_license = require('../../utility/registration/hdb_license');
const NodeObject = require('./NodeObject').Node;

const CLUSTER_PORT = env_mgr.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_PORT_KEY);
const CONFIGURE_SUCCESS_RESPONSE = 'Successfully configured and loaded clustering configuration.  Some configurations may require a restart of HarperDB to take effect.';

//Promisified functions
const p_delete_delete = util.promisify(del.delete);
const p_auth_authorize = util.promisify(auth.authorize);
const p_search_by_hash = util.promisify(search.searchByHash);

const iface = os.networkInterfaces();
const addresses = [];
const started_forks = {};
let is_enterprise = false;
let child_event_count = 0;

const STATUS_TIMEOUT_MS = 10000;
const DUPLICATE_ERR_MSG = 'Cannot add a node that matches the hosts clustering config.';
const TIMEOUT_ERR_MSG = 'Timeout trying to get cluster status.';
const SUBSCRIPTIONS_MUST_BE_ARRAY = 'add_node subscriptions must be an array';

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

/**
 * Kicks off the clustering server and processes.  Only called with a valid license installed.
 * @returns {Promise<void>}
 */
async function kickOffEnterprise() {
    log.trace('clusterUtilities kickOffEnterprise');
    try {
        if(global.clustering_on === true) {
            const enterprise_util = require('../../utility/enterpriseInitialization');
            await enterprise_util.kickOffEnterprise();
        }
    } catch (e) {
        log.error(e);
    }
}

/**
 *
 * @param {NodeObject} new_node
 * @returns {Promise<string|*>}
 */
async function addNode(new_node) {
    nodeValidation(new_node);

    let node_record = new NodeObject(new_node.name, new_node.host, new_node.port, new_node.subscriptions);
    let new_node_insert = new InsertObject("insert", terms.SYSTEM_SCHEMA_NAME, terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME, null, [node_record]);
    let results = undefined;

    if(!(await hdb_license.getLicense()).enterprise) {
        // send a get cluster status message and wait for response
        let cluster_status = await clusterStatus(null);
        if(!cluster_status || !cluster_status.status) {
            return hdb_utils.errorizeMessage('Cannot add a node, not connected to cluster.');
        }
        if((typeof cluster_status.status === 'string') || (cluster_status.status instanceof String)) {
            return hdb_utils.errorizeMessage('Cannot add a node, cluster is busy');
        }
        let status_count = 0;
        if(cluster_status.status.outbound_connections) {
            status_count += cluster_status.status.outbound_connections.length;
            log.debug(`I have ${cluster_status.status.outbound_connections.length} outbound connections.`);
        }
        if(cluster_status.status.inbound_connections) {
            status_count += cluster_status.status.inbound_connections.length;
            log.debug(`I have ${cluster_status.status.inbound_connections.length} inbound connections.`);
        }
        // count # connections, if >= 3, reject
        if(status_count >= terms.BASIC_LICENSE_MAX_CLUSTER_CONNS) {
            return `${terms.LICENSE_MAX_CONNS_REACHED} ${terms.LICENSE_HELP_MSG}`;
        }

    }
    try {
        results = await insert.insert(new_node_insert);
    } catch(err) {
        log.error(`Error adding new cluster node ${new_node_insert}.  ${err}`);
        throw err;
    }

    if(!hdb_utils.isEmptyOrZeroLength(results.skipped_hashes)) {
        log.info(`Node '${new_node.name}' has already been added. Operation aborted.`);
        throw new Error(`Node '${new_node.name}' has already been added. Operation aborted.`);
    }

    try {
        let add_node_msg = new terms.ClusterMessageObjects.HdbCoreAddNodeMessage();
        add_node_msg.add_node = new_node;
        hdb_utils.sendTransactionToSocketCluster(terms.INTERNAL_SC_CHANNELS.HDB_NODES, add_node_msg, env_mgr.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
    } catch(e){
        throw new Error(e);
    }

    return `successfully added ${new_node.name} to manifest`;
}

/**
 *
 * @param {NodeObject} node_object
 */
function nodeValidation(node_object) {
    // need to clean up new node as it hads operation and user on it
    let validation = node_validator(node_object);
    if(validation) {
        log.error(`Validation error in addNode validation. ${validation}`);
        throw new Error(validation);
    }

    let new_port = undefined;
    try {
        new_port = parseInt(node_object.port);
    } catch(err) {
        throw new Error(`Invalid port: ${node_object.port} specified`);
    }

    if(isNaN(new_port)) {
        throw new Error(`Invalid port: ${node_object.port} specified`);
    }

    //TODO: We may need to expand this depending on what is decided in https://harperdb.atlassian.net/browse/HDB-638
    if(new_port === CLUSTER_PORT) {
        if((node_object.host === 'localhost' || node_object.host === '127.0.0.1')) {
            throw new Error(DUPLICATE_ERR_MSG);
        }
        if (addresses && addresses.includes(node_object.host)) {
            throw new Error(DUPLICATE_ERR_MSG);
        }
        if (os.hostname() === node_object.host) {
            throw new Error(DUPLICATE_ERR_MSG);
        }
    }

    // If no subscriptions property is passed create one and set to empty array
    if (hdb_utils.isEmpty(node_object.subscriptions)) {
        node_object.subscriptions = [];
    }

    if (!hdb_utils.isEmptyOrZeroLength(node_object.subscriptions) && !Array.isArray(node_object.subscriptions)) {
        log.error(`${SUBSCRIPTIONS_MUST_BE_ARRAY}: ${node_object.subscriptions}`);
        throw new Error(SUBSCRIPTIONS_MUST_BE_ARRAY);
    }

    let subscription_validation = undefined;
    if (!hdb_utils.isEmptyOrZeroLength(node_object.subscriptions)) {
        for (let b = 0; b < node_object.subscriptions.length; b++) {
            subscription_validation = node_subscription_validator(node_object.subscriptions[b]);
            if (subscription_validation) {
                throw subscription_validation;
            }
        }
    }

    // hdb_user and hdb_auth_header aren't required after this point and shouldn't
    // be included in the insert objects records for add node.
    try {
        delete node_object.hdb_user;
        delete node_object.hdb_auth_header;
    } catch (err) {
        log.warn(`Error delete node_object auth properties: ${err}`);
    }
}

/**
 *
 * @param {NodeObject} update_node
 * @returns {string}
 */
async function updateNode(update_node) {
    if(hdb_utils.isEmpty(update_node.name)) {
        throw new Error('name is required');
    }

    //fecth the existing node and merge with the update_node
    let search_object = {
        schema: terms.SYSTEM_SCHEMA_NAME,
        table: terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME,
        hash_values: [update_node.name],
        get_attributes: ['*']
    };

    let node_search = await p_search_by_hash(search_object);

    if(hdb_utils.isEmptyOrZeroLength(node_search)) {
        log.info(`Node '${update_node.name}' does not exist. Operation aborted.`);
        throw new Error(`Node '${update_node.name}' does not exist. Operation aborted.`);
    }

    let merge_node = node_search[0];
    Object.assign(merge_node, update_node);
    nodeValidation(merge_node);

    let node_record = new NodeObject(update_node.name, update_node.host, update_node.port, update_node.subscriptions);

    let update_node_object = new InsertObject("update", terms.SYSTEM_SCHEMA_NAME, terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME, null, [node_record]);
    let results = undefined;

    try {
        results = await insert.update(update_node_object);
    } catch(err) {
        log.error(`Error adding new cluster node ${update_node_object}.  ${err}`);
        throw new Error(err);
    }

    if (!hdb_utils.isEmptyOrZeroLength(results.skipped_hashes)) {
        log.info(`Node '${update_node.name}' does not exist. Operation aborted.`);
        throw new Error(`Node '${update_node.name}' does not exist. Operation aborted.`);
    }

    try {
        let update_node_msg = new terms.ClusterMessageObjects.HdbCoreUpdateNodeMessage();
        update_node_msg.update_node = merge_node;
        hdb_utils.sendTransactionToSocketCluster(terms.INTERNAL_SC_CHANNELS.HDB_NODES, update_node_msg, env_mgr.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
    } catch (e) {
        throw new Error(e);
    }

    return `successfully updated ${update_node.name}`;
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
        log.error(`Error removing cluster node ${util.inspect(delete_obj)}.  ${err}`);
        throw err;
    }
    if(!hdb_utils.isEmptyOrZeroLength(results.skipped_hashes)) {
        log.info(`Node '${remove_json_message.name}' was not found. Operation aborted.`);
        return `Node '${remove_json_message.name}' was not found.`;
    }
    let remove_node_msg = new terms.ClusterMessageObjects.HdbCoreRemoveNodeMessage();
    remove_node_msg.remove_node = remove_json_message;
    hdb_utils.sendTransactionToSocketCluster(terms.INTERNAL_SC_CHANNELS.HDB_NODES, remove_node_msg, env_mgr.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
    return `successfully removed ${remove_json_message.name} from manifest`;
}

/**
 * Configure clustering by updating the config settings file with the specified paramters in the message, and then
 * start or stop clustering depending on the enabled value.
 * @param enable_cluster_json
 * @returns {Promise<void>}
 */
async function configureCluster(enable_cluster_json) {
    log.debug('In configureCluster');
    let {operation, hdb_user, hdb_auth_header, ...config_fields} = enable_cluster_json;

    // We need to make all fields upper case so they will match in the validator.  It is less efficient to do this in its
    // own loop, but we dont want to update the file unless all fields pass validation, and we can't validate until all
    // fields are converted.
    let field_keys = Object.keys(config_fields);
    for(let i=0; i<field_keys.length; ++i) {
        let orig_field_name = field_keys[i];

        // if the field is not all uppercase in the config_fields object, then add the all uppercase field
        // and remove the old not uppercase field.
        if(config_fields[orig_field_name.toUpperCase()] === undefined) {
            config_fields[orig_field_name.toUpperCase()] = config_fields[orig_field_name];
            delete config_fields[orig_field_name];
        }

        // if the field is not all uppercase in the config_fields object, then add the all uppercase field
        // and remove the old not uppercase field.
        if(enable_cluster_json[orig_field_name.toUpperCase()] === undefined) {
            enable_cluster_json[orig_field_name.toUpperCase()] = enable_cluster_json[orig_field_name];
            delete enable_cluster_json[orig_field_name];
        }
    }

    if(config_fields.NODE_NAME !== undefined){
        config_fields.NODE_NAME = config_fields.NODE_NAME.toString();
    }
    let validation = await configure_validator(config_fields);
    let should_reload = false;
    if (validation) {
        log.error(`Validation error in configureCluster validation. ${validation}`);
        throw new Error(validation);
    }

    try {
        let msg_keys = Object.keys(config_fields);
        for(let i=0; i<msg_keys.length; ++i) {
            let curr = msg_keys[i];

            if(curr && !hdb_utils.isEmptyOrZeroLength(terms.HDB_SETTINGS_NAMES_REVERSE_LOOKUP[curr])) {
                log.info(`Setting property ${curr} to value ${enable_cluster_json[curr]}`);
                env_mgr.setProperty(curr, enable_cluster_json[curr]);
                should_reload = true;
            }
        }
        if(should_reload) {
            await env_mgr.writeSettingsFileSync(true);
            log.info('Completed writing new settings to file and reloading the manager.');
        }
        return CONFIGURE_SUCCESS_RESPONSE;
    } catch(err) {
        log.error(err);
        throw 'There was an error storing the configuration information.  Please check the logs and try again.';
    }
}

/**
 * Get the status of this hosts clustering configuration and connections.  This will send a message to a socket cluster worker,
 * who will request status from all other workers.  Once all workers have reported status, the worker will respond to the
 * HDB Child via the ClusterStatusEmitter.
 * @param cluster_status_json - Inbound message json.
 * @returns {Promise<void>}
 */
async function clusterStatus(cluster_status_json) {
    log.trace(`getting cluster status`);
    let response = {};
    try {
        let clustering_enabled = env_mgr.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_ENABLED_KEY);
        response["is_enabled"] = clustering_enabled;
        if(!clustering_enabled) {
            return response;
        }

        if(!global.hdb_socket_client || !global.hdb_socket_client.socket.id) {
            let msg = 'Cannot request cluster status.  Disconnected from clustering.';
            log.error(msg);
            return msg;
        }
        let cluster_status_msg = hdb_utils.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.GET_CLUSTER_STATUS);
        if(!cluster_status_msg) {
            log.error('Error building a cluster status message');
            return;
        }
        cluster_status_msg.requesting_hdb_worker_id = process.pid;
        cluster_status_msg.requestor_channel = global.hdb_socket_client.socket.id;
        // Don't set originator so the message will be delivered to the worker rather than swallowed.
        hdb_utils.sendTransactionToSocketCluster(cluster_status_msg.requestor_channel, cluster_status_msg, null);
        // If we have more than 1 process, we need to get the status from the master process which has that info stored
        // in global.  We subscribe to an event that master will emit once it has gathered the data.  We want to build
        // in a timeout in case the event never comes.
        let timeout_promise = hdb_utils.timeoutPromise(STATUS_TIMEOUT_MS, TIMEOUT_ERR_MSG);
        let event_promise = hdb_utils.createEventPromise(cluster_status_event.EVENT_NAME, cluster_status_event.clusterEmitter, timeout_promise);
        let result = await Promise.race([event_promise, timeout_promise.promise]);
        log.trace(`cluster status result: ${util.inspect(result)}`);
        try {
            result.node_name = env_mgr.get('NODE_NAME');
            delete result['hdb_header'];
            delete result['__originator'];
            delete result['requestor_channel'];
            delete result['channel'];
            delete result['cluster_status_request_id'];
        } catch(err) {
            //no-op
        }
        response["status"] = result;
    } catch (err) {
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
    for(let i = 0; i < global.forks.length; i++) {
        if(!backup_process && global.forks[i].process.pid !== target_process_id) {
            // Set a backup process to send the message to in case we don't find the specified process.
            backup_process = global.forks[i];
        }
        if(global.forks[i].process.pid === target_process_id) {
            specified_process = global.forks[i];
            log.info(`Processing job on process: ${target_process_id}`);
            return specified_process;
        }
    }
    if(!specified_process && backup_process) {
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
        for(let conn of global.cluster_server.socket_client) {
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
                log.trace(`Got child started event`);
                if(started_forks[msg.pid]) {
                    log.warn(`Got a duplicate child started event for pid ${msg.pid}`);
                } else {
                    child_event_count++;
                    log.info(`Received ${child_event_count} child started event(s).`);
                    started_forks[msg.pid] = true;
                    if(Object.keys(started_forks).length === global.forks.length) {
                        //all children are started, kick off enterprise.
                        child_event_count = 0;
                        try {
                            kickOffEnterprise().then(() => {
                                log.info('clustering initialized');
                            });
                        } catch(e) {
                            log.error('clustering failed to start: ' + e);
                        }
                    }
                }
                break;
            case terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STOPPED:
                log.trace(`Got child stopped event`);
                if(started_forks[msg.pid] === false) {
                    log.warn(`Got a duplicate child started event for pid ${msg.pid}`);
                } else {
                    child_event_count++;
                    log.info(`Received ${child_event_count} child stopped event(s).`);
                    log.info(`started forks: ${util.inspect(started_forks)}`);
                    started_forks[msg.pid] = false;
                    for(let fork of Object.keys(started_forks)) {
                        // We still have children running, break;
                        if(started_forks[fork] === true) {
                            return;
                        }
                    }
                    //All children are stopped, emit event
                    log.debug(`All children stopped, restarting.`);
                    child_event_count = 0;
                    children_stopped_event.allChildrenStoppedEmitter.emit(children_stopped_event.EVENT_NAME, new children_stopped_event.AllChildrenStoppedMessage());
                }
                break;
            case terms.CLUSTER_MESSAGE_TYPE_ENUM.RESTART:
                log.info('Received restart event.');
                if(!global.forks || global.forks.length === 0) {
                    log.info('No processes found');
                } else {
                    log.info(`Shutting down ${global.forks.length} process.`);
                }

                if(msg.force_shutdown) {
                    restartHDB();
                    log.info('Force shutting down processes.');
                    break;
                }

                for(let i=0; i<global.forks.length; i++) {
                    if(global.forks[i]) {
                        try {
                            log.debug(`Sending ${terms.RESTART_CODE} signal to process with pid:${global.forks[i].process.pid}`);
                            global.forks[i].send({type: terms.CLUSTER_MESSAGE_TYPE_ENUM.RESTART});
                        } catch(err) {
                            log.error(`Got an error trying to send ${terms.RESTART_CODE} to process ${global.forks[i].process.pid}.`);
                        }
                    }
                }
                // Try to shutdown all SocketServer and SocketClient connections.
                if(global.cluster_server) {
                    // Close server will emit an event once it is done
                    global.cluster_server.closeServer();
                }
                break;
            default:
                log.info(`Got an unhandled cluster message type ${msg.type}`);
                break;
        }
    } catch (e) {
        log.error(e);
    }
}

async function authHeaderToUser(json_body) {
    let req = {};
    req.headers = {};
    req.headers.authorization = json_body.hdb_auth_header;

    let user = await p_auth_authorize(req, null)
        .catch((e) => {
            throw e;
        });
    json_body.hdb_user = user;
    return json_body;
}

/**
 * Function spawns child process and calls restart.
 */
function restartHDB() {
    try {
        // try to change to 'bin' dir
        let command = (global.running_from_repo ? 'node' : 'harperdb');
        let args = (global.running_from_repo ? ['harperdb', 'restart'] : ['restart']);
        let base = env_mgr.get(terms.HDB_SETTINGS_NAMES.PROJECT_DIR_KEY);
        process.chdir(path.join(base, 'bin'));
        let child = child_process.spawn(command, args, {detached:true, stdio: "ignore"});
       child.unref();
    } catch (err) {
        let msg = `There was an error restarting HarperDB.  Please restart manually. ${err}`;
        console.log(msg);
        log.error(msg);
        throw err;
    }
}

/**
 * Test if the passed value is null or undefined.  This will not check string length.
 * @param value - the value to test
 * @returns {boolean}
 */
function isEmpty(value) {
    return (value === undefined || value === null);
}

module.exports = {
    addNode,
    updateNode: updateNode,
    // The reference to the callback functions can be removed once processLocalTransaction has been refactored
    configureCluster,
    clusterStatus,
    removeNode: removeNode,
    clusterMessageHandler: clusterMessageHandler,
    authHeaderToUser: authHeaderToUser,
    setEnterprise: setEnterprise,
    restartHDB: restartHDB,
    isEmpty
};