'use strict';

const global_schema = require('../utility/globalSchema');
const user_schema = require('../utility/user_schema');
const promisify = require('util').promisify;
const p_schema_to_global = promisify(global_schema.setSchemaDataToGlobal);
const server_utils = require('../server/serverUtilities');
const spawn_cluster_connection = require('../server/socketcluster/connector/spawnSCConnection');
const p_timeout = promisify(setTimeout);
const CONNECT_TRIES = 5;
const TIMEOUT_MS = 20;

process.on('message', thread);

/**
 * function to handle running job operations in a background process
 * @param {Object} argument - the original operation sent to HDB
 * @returns {Promise<void>}
 */
async function thread(argument){
    try {
        await p_schema_to_global();
        await user_schema.setUsersToGlobal();
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
    if(global.hdb_socket_client === undefined || global.hdb_socket_client.socket === undefined){
        return;
    }

    let socket = global.hdb_socket_client.socket;
    if(socket.state === socket.CLOSED){
        return;
    }

    for(let x = 0; x < CONNECT_TRIES; x++){
        if(socket.state === socket.OPEN && socket.authState === socket.AUTHENTICATED){
            break;
        }
        await p_timeout(TIMEOUT_MS);
    }
}

module.exports = thread;