'use strict';

const log = require('../../../utility/logging/harper_logger');

const promisify = require('util').promisify;
const sc_util = require('../util/socketClusterUtils');
const types = require('../types');

const EVENT_TYPES = {
    ERROR: `error`,
    RAW: `raw`,
    DISCONNECT: `disconnect`,
    CONNECT: 'connect',
    CONNECT_ABORT: 'connectAbort',
    CLOSE: 'close',
    SUBSCRIBE: 'subscribe',
    UNSUBSCRIBE: 'unsubscribe',
    AUTHENTICATE: 'authenticate',
    DEAUTHENTICATE: 'deauthenticate',
    AUTH_STATE_CHANGE: 'authStateChange',
    MESSAGE: 'message'
};

/**
 * This class establishes the handlers for the socket on the server, handling all messaging & state changes related to a connected client
 */
class ServerSocket{
    /**
     *
     * @param {../worker/ClusterWorker} worker
     * @param socket
     */
    constructor(worker, socket){
        this.worker = worker;
        this.socket = socket;
        this.registerHandlers();

        this.exchange_set = promisify(this.worker.exchange.set).bind(this.worker.exchange);
        this.exchange_get = promisify(this.worker.exchange.get).bind(this.worker.exchange);
        this.exchange_remove = promisify(this.worker.exchange.remove).bind(this.worker.exchange);
    }

//TODO probably better to detetct the connect/disconnect events and check for a header saying its a worker
    registerHandlers(){
        this.socket.on(EVENT_TYPES.ERROR, this.errorHandler);
        this.socket.on(EVENT_TYPES.RAW, this.rawHandler);
        this.socket.on(EVENT_TYPES.DISCONNECT, this.disconnectHandler.bind(this));
        this.socket.on(EVENT_TYPES.CONNECT, this.connectHandler.bind(this));
        this.socket.on(EVENT_TYPES.CONNECT_ABORT, this.connectAbortHandler);
        this.socket.on(EVENT_TYPES.CLOSE, this.closeHandler);
        this.socket.on(EVENT_TYPES.SUBSCRIBE, this.subscribeHandler.bind(this));
        this.socket.on(EVENT_TYPES.UNSUBSCRIBE, this.unsubscribeHandler.bind(this));
        this.socket.on(EVENT_TYPES.AUTHENTICATE, this.authenticateHandler);
        this.socket.on(EVENT_TYPES.DEAUTHENTICATE, this.deauthenticateHandler.bind(this));
        this.socket.on(EVENT_TYPES.AUTH_STATE_CHANGE, this.authStateChangeHandler);
        this.socket.on(EVENT_TYPES.MESSAGE, this.messageHandler);

        this.socket.on(types.EMIT_TYPES.CATCHUP, this.catchup);
        this.socket.on(types.EMIT_TYPES.SCHEMA_CATCHUP, this.catchup);
    }

    /**
     *
     * @param {<CatchupObject>} catchup_object
     */
    async catchup(catchup_object, response){
        //TODO validate catchup object https://harperdb.atlassian.net/browse/CORE-409
        try {
            let catchup_msg = await sc_util.catchupHandler(catchup_object.channel, Date.now() - catchup_object.milis_since_connected, null);
            response(null, catchup_msg);
        } catch(e){
            log.error(e);
            response(e);
        }
    }

    /**
     *
     * @param {<CatchupObject>} catchup_object
     */
    async schema_catchup(catchup_object, response) {
        try {
            let schema_catchup_msg = await sc_util.schemaCatchupHandler();
            response(null, schema_catchup_msg);
        } catch(e) {
            log.error('Error generating a schema catch up message.');
            log.error(e);
            response(e);
        }
    }

    /**
     * This gets triggered when an error occurs on this socket. Argument is the error object.
     * @param error
     */
    errorHandler(error){
        log.error(error);
    }

    /**
     * This gets triggered whenever the client socket on the other side calls socket.send(...).
     * @param data
     */
    rawHandler(data){

    }

    /**
     * Happens when the client becomes disconnected from the server. Note that if the socket becomes disconnected during the SC handshake stage, then the 'connectAbort' event will be triggered instead.
     * @param code
     * @param data
     */
    disconnectHandler(code, data){
    }

    /**
     * Happens when the client becomes disconnected from the server. Note that if the socket becomes disconnected during the SC handshake stage, then the 'connectAbort' event will be triggered instead.
     * @param code
     * @param data
     */
    connectHandler(code, data){

    }


    /**
     * Happens when the client disconnects from the server before the SocketCluster handshake has completed (I.e. while socket.state was 'connecting').
     * Note that the 'connectAbort' event can only be triggered during the socket's handshake phase before the server's 'connection' event is triggered.
     * @param code
     * @param data
     */
    connectAbortHandler(code, data){

    }

    /**
     * Happens when the client disconnects from the server at any stage of the handshake/connection cycle. Note that this event is a catch-all for both 'disconnect' and 'connectAbort' events.
     * @param code
     * @param data
     */
    closeHandler(code, data){

    }

    /**
     * Emitted when the matching client socket successfully subscribes to a channel.
     * @param channel
     */
    subscribeHandler(channel){
        log.debug(this.socket.id + ' subscribed to channel ' + channel);
    }

    /**
     * Occurs whenever the matching client socket unsubscribes from a channel - This includes automatic unsubscriptions triggered by disconnects.
     * @param channel
     */
    unsubscribeHandler(channel){
        log.debug('unsubscribed from channel ' + channel);
    }

    /**
     * Triggers whenever the client becomes authenticated. The listener will receive the socket's authToken object as argument.
     * @param authToken
     */
    authenticateHandler(authToken){

    }

    /**
     * Triggers whenever the client becomes unauthenticated. The listener will receive the socket's old authToken object as argument (just before the deauthentication took place).
     * when a connection deauthenticates it can be due to the JWT expiring so we ask the connection to reauthenticate
     * @param oldAuthToken
     */
    deauthenticateHandler(oldAuthToken){
        sc_util.requestAndHandleLogin(this.socket, this.worker.hdb_users);
    }

    /**
     * Triggers whenever the socket's authState changes (e.g. transitions between authenticated and unauthenticated states).
     * @param stateChangeData
     */
    authStateChangeHandler(stateChangeData){

    }

    /**
     * All data that arrives on this socket is emitted through this event as a string.
     * @param message
     */
    messageHandler(message){
    }
}

module.exports = ServerSocket;