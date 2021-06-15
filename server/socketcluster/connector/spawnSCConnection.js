'use strict';
const socketclient = require('socketcluster-client');
const HDBSocketConnector = require('./HDBSocketConnector');
const SocketConnector = require('./SocketConnector');
const crypto_hash = require('../../../security/cryptoHash');
let connector_options = require('../../../json/hdbConnectorOptions');
const log = require('../../../utility/logging/harper_logger');
const utils = require('../../../utility/common_utils');

const env = require('../../../utility/environment/environmentManager');
if(!env.isInitialized()) {
    env.initSync();
}

const SC_WORKER_NAME_PREFIX = 'worker_';

module.exports = spawnSCConnection;

/**
 * creates the sc client connection to the local SC server
 * @param is_worker
 */
function spawnSCConnection(is_worker){
    if(env.get('CLUSTERING') !== true){
        return;
    }

    //get the CLUSTER_USER
    let cluster_user_name = env.get('CLUSTERING_USER');

    if(utils.isEmpty(cluster_user_name)){
        log.warn('No CLUSTERING_USER found, unable connect to local clustering server');
        return;
    }

    let cluster_user = utils.getClusterUser(global.hdb_users, cluster_user_name);

    if(utils.isEmpty(cluster_user)){
        log.warn('No CLUSTERING_USER found, unable connect to local clustering server');
        return;
    }
    global.clustering_on = true;
    let creds = {
        username: cluster_user.username,
        password: crypto_hash.decrypt(cluster_user.hash)
    };

    let SocketClass = HDBSocketConnector;
    if(is_worker !== true){
        delete connector_options.query;
        SocketClass = SocketConnector;
    }

    connector_options.hostname = 'localhost';
    connector_options.port = env.get('CLUSTERING_PORT');
    global.hdb_socket_client = new SocketClass(socketclient, {name: SC_WORKER_NAME_PREFIX + process.pid}, connector_options, creds);
}