'use strict';

const global_schema = require('../utility/globalSchema');
const user = require('../security/user');
const promisify = require('util').promisify;
const p_schema_to_global = promisify(global_schema.setSchemaDataToGlobal);
const server_utils = require('../server/serverUtilities');
const spawn_cluster_connection = require('../server/socketcluster/connector/spawnSCConnection');
const log = require('../utility/logging/harper_logger');
const p_timeout = promisify(setTimeout);
const CONNECT_TRIES = 5;
const TIMEOUT_MS = 50;

process.on('message', thread);

/**
 * function to handle running job operations in a background process
 * @param {Object} argument - the original operation sent to HDB
 * @returns {Promise<void>}
 */
async function thread(argument){
    try {
        await p_schema_to_global();
        await user.setUsersToGlobal();
        spawn_cluster_connection(false);
        await waitForSocketToConnect();
        let operation = server_utils.getOperationFunction(argument);
        let results = await operation.job_operation_function(argument);
        let thread_response = {thread_results: results === undefined ? null : results};

        process.send(thread_response);
    }catch(e){
        let e_message = e.message !== undefined ? e.message : e;
        process.send({error: e_message, stack: e.stack});
    }
}

/**
 * tries 5 times to see if the socket connection, if there is one, is connected and authenticated
 * @returns {Promise<void>}
 */
async function waitForSocketToConnect(){
    log.info('thread socket connection waiting to connect');
    if(global.hdb_socket_client === undefined || global.hdb_socket_client.socket === undefined){
        log.info('no thread socket connection to confirm');
        return;
    }

    let socket = global.hdb_socket_client.socket;
    if(socket.state === socket.CLOSED){
        log.warn('thread socket connection could not connect to server');
        return;
    }

    for(let x = 0; x < CONNECT_TRIES; x++){
        if(socket.state === socket.OPEN && socket.authState === socket.AUTHENTICATED){
            log.info('thread socket connection successfully authenticated');
            break;
        }
        await p_timeout(TIMEOUT_MS);
    }

    log.info(`thread socket connection exiting confirmation: ${socket.state}, ${socket.authState}`);
}

module.exports = thread;
