"use strict";

const fs = require('fs-extra');
const hdb_terms = require('../../../utility/hdbTerms');
const log = require('../../../utility/logging/harper_logger');
const {inspect} = require('util');
const CatchUp = require('../handlers/CatchUp');
const env = require('../../../utility/environment/environmentManager');
env.initSync();
const HDB_QUEUE_PATH = env.getHdbBasePath() + '/clustering/transaction_log/';
const utils = require('../../../utility/common_utils');
const get_cluster_user = require('../../../utility/common_utils').getClusterUser;
const password_utility = require('../../../utility/password');
const types = require('../types');
const global_schema = require('../../../utility/globalSchema');
const {promisify} = require('util');

const SC_TOKEN_EXPIRATION = '1d';
const CATCHUP_OFFSET_MS = 100;

const p_set_schema_to_global = promisify(global_schema.setSchemaDataToGlobal);

class ConnectionDetails {
    constructor(id, host_address, host_port, state) {
        this.id = id;
        this.host_address = host_address;
        this.host_port = host_port;
        this.state = state;
        this.node_name = undefined;
        this.subscriptions = [];
    }
}

/**
 * Gets the status from the worker parameter and crams it into the status response message parameter.
 * @param status_response_msg - A status response message that will have the status added to.
 * @param worker - the worker to get status from.
 * @returns null
 */
function getWorkerStatus(status_response_msg, worker) {
    log.trace(`getWorkerStatus`);
    try {
        if (worker.node_connector && worker.node_connector.connections && worker.node_connector.connections.clients) {
            let client_keys = Object.keys(worker.node_connector.connections.clients);
            for (let i = 0; i < client_keys.length; i++) {
                let client = worker.node_connector.connections.clients[client_keys[i]];
                let conn = new ConnectionDetails('', client.options.hostname, client.options.port, client.state);
                if (client.additional_info) {
                    conn['subscriptions'] = [];
                    conn.node_name = client.additional_info.name;
                    for (let i = 0; i < client.additional_info.subscriptions.length; i++) {
                        let sub = client.additional_info.subscriptions[i];
                        if (sub.channel.indexOf(hdb_terms.HDB_INTERNAL_SC_CHANNEL_PREFIX) === 0) {
                            continue;
                        }
                        conn.subscriptions.push(sub);
                    }
                }
                status_response_msg.outbound_connections.push(conn);
            }
        }
        if (worker.scServer && worker.scServer.clients) {
            let client_keys = Object.keys(worker.scServer.clients);
            for (let i = 0; i < client_keys.length; i++) {
                let client = worker.scServer.clients[client_keys[i]];//worker.scServer.clients[i];
                let conn = new ConnectionDetails(client.id, client.remoteAddress, client.remotePort, client.state);
                if (client.exchange && client.exchange._channels) {
                    let channel_keys = Object.keys(client.exchange._channels);
                    for (let i = 0; i < channel_keys.length; i++) {
                        let sub = client.exchange._channels[channel_keys[i]];
                        if (sub.name.indexOf(hdb_terms.HDB_INTERNAL_SC_CHANNEL_PREFIX) === 0) {
                            continue;
                        }
                        conn.subscriptions.push({"channel": sub.name, "state": sub.state});
                    }
                }
                status_response_msg.inbound_connections.push(conn);
            }
        }
    } catch(err) {
        log.error(`There was an error getting worker status.`);
        log.error(err);
    }
}

/**
 * Creates a promise around an expected event and a timeout around that event.  If the event happens, the timeout will be
 * cancelled.  If it times out, we still send a resolve with the timeout message.
 * @param event_name - The name of the event we expect to get
 * @param event_emitter_object - The EventEmitter object to listen for the event on.
 * @param timeout_promise - A timeout promise object, which can be constructed with a function in common_utils.js.
 * @returns {Promise<any>}
 */
function createEventPromise(event_name, event_emitter_object, timeout_promise) {
    let event_promise = new Promise((resolve) => {
        event_emitter_object.on(event_name, (msg) => {
            let curr_timeout_promise = timeout_promise;
            //timeout_promise = hdb_utils.timeoutPromise(STATUS_TIMEOUT_MS, TIMEOUT_ERR_MSG);
            log.info(`Got cluster status event response: ${inspect(msg)}`);
            try {
                curr_timeout_promise.cancel();
            } catch(err) {
                log.error('Error trying to cancel timeout.');
            }
            resolve(msg);
        });
    });
    return event_promise;
}

/**
 * Calls the Catchup class to read a specific transaction log with a time range.
 * Creates a catchup payload based on the results from Catchup and publishes to a socket
 * @returns {Promise<void>}
 */
async function schemaCatchupHandler() {
    if(!global.hdb_schema) {
        try {
            await p_set_schema_to_global();
        } catch (err) {
            log.error(`Error settings schema to global.`);
            log.error(err);
            throw err;
        }
    }
    let catch_up_msg = utils.getClusterMessage(hdb_terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
    catch_up_msg.transaction = {};
    catch_up_msg.catchup_schema = global.hdb_schema;

    return catch_up_msg;
}

/**
 * Calls the Catchup class to read a specific transaction log with a time range.
 * Creates a catchup payload based on the results from Catchup and publishes to a socket
 * @param channel
 * @param start_timestamp
 * @param end_timestamp
 * @param socket
 * @returns {Promise<void>}
 */
async function catchupHandler(channel, start_timestamp, end_timestamp = Date.now()){
    if(!channel){
        throw new Error('channel is required');
    }

    if(!start_timestamp || !Number.isInteger(start_timestamp)){
        throw new Error('invalid start_timestamp');
    }

    if(start_timestamp > end_timestamp){
        throw new Error('end_timestamp must be greater than start_timestamp');
    }

    let channel_log_path = utils.buildFolderPath(HDB_QUEUE_PATH, channel);
    let channel_audit_path = utils.buildFolderPath(channel_log_path, types.ROTATING_TRANSACTION_LOG_ENUM.AUDIT_LOG_NAME);

    //check if the channel transaction log path & channel audit file exists
    try {
        await fs.access(channel_log_path, fs.constants.R_OK | fs.constants.F_OK);
        await fs.access(channel_audit_path, fs.constants.R_OK | fs.constants.F_OK);
    } catch(e){
        log.info(`transacion log path for channel ${channel} does not exist`);
        //doesn't exist so we exit
        return;
    }

    try {
        let audit_string = await fs.readFile(channel_audit_path);
        let channel_log_audit = JSON.parse(audit_string.toString());

        let results = [];

        //get files to read for catchup, iterate the files list, the list is oldest to newest.
        for (let x = 0; x < channel_log_audit.files.length; x++) {
            let log_metadata = channel_log_audit.files[x];
            //we add an offset to account for the date on the log being off by a few milliseconds from the transaction time, because the transaction passes from hdb -> sc server before being written
            if ((log_metadata.date + CATCHUP_OFFSET_MS) >= start_timestamp && (log_metadata.date + CATCHUP_OFFSET_MS) <= end_timestamp) {
                let reader = new CatchUp(log_metadata.name, start_timestamp, end_timestamp);
                await reader.run();
                if (Array.isArray(reader.results) && reader.results.length > 0) {
                    results = results.concat(reader.results);
                }
            }
        }

        if (Array.isArray(results) && results.length > 0) {
            let catchup_response = {
                channel: channel,
                operation: 'catchup',
                transactions: results
            };

            let catch_up_msg = utils.getClusterMessage(hdb_terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
            catch_up_msg.transaction = catchup_response;

            return catch_up_msg;
        }
    }catch(e){
        log.error(e);
    }
}

/**
 * send the socket a request to login, validate and process
 * @param socket
 * @param hdb_users
 */
function requestAndHandleLogin(socket, hdb_users){
    socket.emit('login', 'send login credentials', (error, credentials)=>{
        if(error){
            console.error(error);
            return false;
        }

        if(!credentials || !credentials.username || !credentials.password){
            console.error('Invalid credentials');
            return false;
        }

        handleLoginResponse(socket, credentials, hdb_users);
        log.info('socket successfully authenticated');
    });
}

/**
 *  Take the socket & it's credentials and match to the hdb_users
 * @param socket
 * @param credentials
 * @param hdb_users
 */
function handleLoginResponse(socket, credentials, hdb_users) {
    log.trace('handleLoginResponse');
    try {
        let users = Object.values(hdb_users);
        let found_user = get_cluster_user(users, credentials.username);

        if (found_user === undefined || !password_utility.validate(found_user.password, credentials.password)) {
            socket.destroy();
            return log.error('invalid user, access denied');
        }

        //set the JWT to expire in 1 day
        socket.setAuthToken({username: credentials.username}, {expiresIn: SC_TOKEN_EXPIRATION});
    } catch(e){
        log.error(e);
    }
}

module.exports = {
    getWorkerStatus,
    createEventPromise,
    catchupHandler,
    schemaCatchupHandler,
    requestAndHandleLogin
};