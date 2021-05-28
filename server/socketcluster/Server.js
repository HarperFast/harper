'use strict';
const SocketCluster = require('socketcluster');
const fs = require('fs-extra');
const env = require('../../utility/environment/environmentManager');
env.initSync();
const terms = require('../../utility/hdbTerms');
const PROPS_PRIVATE_KEY = 'PRIVATE_KEY';
const PROPS_CERT_KEY = 'CERTIFICATE';
const PRIVATE_KEY = env.get(PROPS_PRIVATE_KEY);
const CERTIFICATE = env.get(PROPS_CERT_KEY);

const log = require('../../utility/logging/harper_logger');
const PORT = env.get('CLUSTERING_PORT');
const DEFAULT_PORT = 12345;

//initializes a new socket cluster all options can be seen here: https://socketcluster.io/#!/docs/api-socketcluster
let socketCluster = undefined;
try {
    log.trace('Starting Cluster Server');
    socketCluster = new SocketCluster({
        // Number of worker processes, this will be config based
        workers: 1,

        // Number of broker processes
        brokers: 1,

        // The port number on which your server should listen, this is config based
        port: PORT ? PORT : DEFAULT_PORT,

        appName: 'socket_server',

        // The default expiry for auth tokens in seconds
        authDefaultExpiry: 604800,

        environment: 'prod',

        // The algorithm to use to sign and verify JWT tokens.
        authAlgorithm: 'HS256',

        // The interval in milliseconds on which to
        // send a ping to the client to check that
        // it is still alive
        pingInterval: 20000,

        // How many milliseconds to wait without receiving a ping
        // before closing the socket
        pingTimeout: 60000,

        // In milliseconds, how long a client has to connect to SC before timing out
        connectTimeout: 10000,

        // In milliseconds - If the socket handshake hasn't been completed before
        // this timeout is reached, the new connection attempt will be terminated.
        handshakeTimeout: 10000,

        // Origins which are allowed to connect to the real-time scServer
        origins: '*:*',

        // In milliseconds, the timeout for calling res(err, data) when
        // your emit() call expects an ACK response from the other side
        // (when callback is provided to emit)
        ackTimeout: 60000,

        // will always be https
        protocol: 'https',

        protocolOptions: {key: fs.readFileSync(`${PRIVATE_KEY}`), cert: fs.readFileSync(`${CERTIFICATE}`)},

        /* A JS file which you can use to configure each of your
         * workers/servers - This is where most of your backend code should go
         */
        workerController: __dirname + `/worker/ClusterWorker.${terms.CODE_EXTENSION}`,

        /* JS file which you can use to configure each of your
         * brokers - Useful for scaling horizontally across multiple machines (optional)
         */
        brokerController: __dirname + `/broker.${terms.CODE_EXTENSION}`,

        // Whether or not to reboot the worker in case it crashes (defaults to true)
        rebootWorkerOnCrash: true,

        middlewareEmitWarnings: false,

        // This can be the name of an npm module or a path to a Node.js module
        // to use as the WebSocket server engine.
        // You can now set this to 'sc-uws' for a speedup.
        wsEngine: 'ws',

        logLevel: 1
    });

    registerHandlers();

} catch(err) {
    log.fatal('There was a fatal error starting clustering.  Please check the logs and try again.');
    log.fatal(err);
}

function registerHandlers() {
    log.trace('Registering Server handlers');
    socketCluster.on('fail', failHandler);
    socketCluster.on('warning', warningHandler);
    socketCluster.on('workerStart', workerStartHandler);
    socketCluster.on('workerExit', workerExitHandler);
    socketCluster.on('workerMessage', workerMessageHandler);
    socketCluster.on('workerClusterStart', workerClusterStartHandler);
    socketCluster.on('workerClusterReady', workerClusterReadyHandler);
    socketCluster.on('workerClusterExit', workerClusterExitHandler);
    socketCluster.on('brokerStart', brokerStartHandler);
    socketCluster.on('brokerExit', brokerExitHandler);
    socketCluster.on('brokerMessage', brokerMessageHandler);
}

/**
 * Any error from any child process or parent will cause the 'fail' event to be emitted on your SocketCluster instance (assuming the propagateErrors option is not set to false).
 * @param error
 */
function failHandler(error){

}

/**
 * Triggered by a warning from any child process or parent.
 * @param warning
 */
function warningHandler(warning){

}

/**
 * Emitted whenever a worker is launched. This event's handler can take a workerInfo object as argument.
 * This workerInfo object has an id property (the lead worker will always have id 0),
 * a pid property and a respawn property which indicates whether or not the worker respawned (not the first launch).
 * @param workerInfo
 */
function workerStartHandler(worker_info){
    log.trace('worker start', worker_info);
}

/**
 * Emitted whenever a worker exits.
 * This event's handler can take a workerInfo object as argument. This workerInfo object has an id property (the id of the worker),
 * a pid property, a code property (the exit code) and a signal property (if terminated using a signal).
 * @param worker_info
 */
function workerExitHandler(worker_info){

}

/**
 * Emitted when a worker process sends a message to this parent process. T
 * he first parameter passed to the handler is the worker id, the second parameter is the data/object sent by the worker, the third parameter is the respond callback.
 * @param worker_id
 * @param data
 * @param callback
 */
function workerMessageHandler(worker_id, data, callback){

}

/**
 * Emitted whenever the WorkerCluster is launched (the WorkerCluster handles load balancing between workers). T
 * his event's handler can take a workerClusterInfo object as argument.
 * This workerClusterInfo object has a pid property and a childProcess property which is a reference to the WorkerCluster process.
 * @param workerClusterInfo
 */
function workerClusterStartHandler(worker_cluster_info){
    log.trace('worker cluster start');
}

/**
 * Emitted whenever the WorkerCluster is ready (after all of its child workers have launched).
 * This event's handler can take a workerClusterInfo object as argument.
 * This workerClusterInfo object has a pid property and a childProcess property which is a reference to the WorkerCluster process.
 * @param worker_cluster_info
 */
function workerClusterReadyHandler(worker_cluster_info){
    log.trace('worker cluster ready');
}

/**
 * Emitted whenever the WorkerCluster exits. This event's handler can take a workerClusterInfo object as argument.
 * This workerClusterInfo object has a pid property, a code property (the exit code) and a signal property
 * (if terminated using a signal) and a childProcess property which is a reference to the WorkerCluster process.
 * @param worker_cluster_info
 */
function workerClusterExitHandler(worker_cluster_info){
    log.trace('Worker Cluster Exited.');
}

/**
 * Emitted whenever a broker is launched. This event's handler can take a brokerInfo object as argument.
 * This brokerInfo object has an id property (the lead broker will always have id 0), a pid property and
 * a respawn property which indicates whether or not the broker respawned (not the first launch).
 * @param broker_info
 */
function brokerStartHandler(broker_info){
    log.trace('broker start', broker_info);
    log.notify('The message broker has started.');
}

/**
 * Emitted whenever a broker exits. This event's handler can take a brokerInfo object as argument.
 * This brokerInfo object has an id property (the id of the broker), a pid property, a code property (the exit code) and a signal property (if terminated using a signal).
 * @param broker_info
 */
function brokerExitHandler(broker_info){
    log.notify('The message broker has stopped.');
}

/**
 * Emitted when a broker process sends a message to this parent process.
 * The first parameter passed to the handler is the broker id, the second parameter is the data/object sent by the broker, the third parameter is the respond callback.
 * @param broker_id
 * @param data
 * @param callback
 */
function brokerMessageHandler(broker_id, data, callback){

}