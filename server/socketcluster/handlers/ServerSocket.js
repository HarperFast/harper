'use strict';

const log = require('../../../utility/logging/harper_logger');


/**
 * This class establishes the handlers for the socket on the server, handling all messaging & state changes related to a connected client
 */
class ServerSocket{
    constructor(worker, socket){
        this.worker = worker;
        this.socket = socket;
        this.registerHandlers();
    }

    registerHandlers(){
        this.socket.on('error', this.errorHandler);
        this.socket.on('raw', this.rawHandler);
        this.socket.on('disconnect', this.disconnectHandler.bind(this));
        this.socket.on('connectAbort', this.connectAbortHandler);
        this.socket.on('close', this.closeHandler);
        this.socket.on('subscribe', this.subscribeHandler);
        this.socket.on('unsubscribe', this.unsubscribeHandler);
        this.socket.on('authenticate', this.authenticateHandler);
        this.socket.on('deauthenticate', this.deauthenticateHandler.bind(this));
        this.socket.on('authStateChange', this.authStateChangeHandler);
        this.socket.on('message', this.messageHandler);
        this.socket.on('register_worker', this.registerWorkerHandler.bind(this));

        this.socket.on('node', (data)=>{
            this.worker.node = data;
        });
    }

    registerWorkerHandler(data){
        let register_object = {};
        register_object[this.socket.id] = true;
        this.socket.is_hdb_worker = true;
        this.worker.exchange.add('hdb_workers', register_object, (err)=>{
            if(err){
                console.error(err);
            }

            this.worker.exchange.get('hdb_workers', (err, data)=>{
                console.log(data);
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
        this.worker.exchange.get(['hdb_workers', this.socket.id], (err, data)=>{
            if(err){
                console.error(err);
            }

            if(data === true){

            }
        });
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
        //add logic for subscribe to hdb_worker channel
        if(channel === 'hdb_worker'){
            this.worker.exchange.add(['hdb_workers', this.socket.id], (err)=>{
        }
        console.log('subscribed to channel ' + channel);
    }

    /**
     * Occurs whenever the matching client socket unsubscribes from a channel - This includes automatic unsubscriptions triggered by disconnects.
     * @param channel
     */
    unsubscribeHandler(channel){
        //add logic for unsubscribe to hdb_worker channel
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