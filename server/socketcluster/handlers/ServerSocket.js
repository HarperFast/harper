'use strict';

const log = require('../../../utility/logging/harper_logger');

const promisify = require('util').promisify;

/**
 * This class establishes the handlers for the socket on the server, handling all messaging & state changes related to a connected client
 */
class ServerSocket{
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
        this.socket.on('error', this.errorHandler);
        this.socket.on('raw', this.rawHandler);
        this.socket.on('disconnect', this.disconnectHandler.bind(this));
        this.socket.on('connect', this.connectHandler.bind(this));
        this.socket.on('connectAbort', this.connectAbortHandler);
        this.socket.on('close', this.closeHandler);
        this.socket.on('subscribe', this.subscribeHandler.bind(this));
        this.socket.on('unsubscribe', this.unsubscribeHandler.bind(this));
        this.socket.on('authenticate', this.authenticateHandler);
        this.socket.on('deauthenticate', this.deauthenticateHandler.bind(this));
        this.socket.on('authStateChange', this.authStateChangeHandler);
        this.socket.on('message', this.messageHandler);

        this.socket.on('query', (data)=>{
            this.exchange_get([data]).then(result=>{
                console.log(result);
            });
        });
    }

    /**
     * This gets triggered when an error occurs on this socket. Argument is the error object.
     * @param error
     */
    errorHandler(error){
        console.error(error);
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
        console.log(this.socket.id + ' subscribed to channel ' + channel);
    }

    /**
     * Occurs whenever the matching client socket unsubscribes from a channel - This includes automatic unsubscriptions triggered by disconnects.
     * @param channel
     */
    unsubscribeHandler(channel){
        console.log('unsubscribed from channel ' + channel);
    }

    /**
     * Triggers whenever the client becomes authenticated. The listener will receive the socket's authToken object as argument.
     * @param authToken
     */
    authenticateHandler(authToken){

    }

    /**
     * Triggers whenever the client becomes unauthenticated. The listener will receive the socket's old authToken object as argument (just before the deauthentication took place).
     * @param oldAuthToken
     */
    deauthenticateHandler(oldAuthToken){

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
        // console.log('message received: ', message );
    }
}

module.exports = ServerSocket;