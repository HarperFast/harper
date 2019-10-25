'use strict';
const ServerSocket = require('./ServerSocket');
const log = require('../../../utility/logging/harper_logger');
const terms = require('../../../utility/hdbTerms');
const RoomMessageObjects = require('../room/RoomMessageObjects');
const {inspect} = require('util');
const hdb_license = require('../../../utility/registration/hdb_license');

class SCServer{
    constructor(worker){
        this.worker = worker;
        this.sc_server = worker.scServer;
        this.registerHandlers();
    }

    /**
     * registers all event handlers to the sc_server
     */
    registerHandlers(){
        this.sc_server.on('error', this.errorHandler.bind(this));
        this.sc_server.on('notice', this.noticeHandler.bind(this));
        this.sc_server.on('handshake', this.handshakeHandler.bind(this));
        this.sc_server.on('connectionAbort', this.connectionAbortHandler.bind(this));
        this.sc_server.on('connection', this.connectionHandler.bind(this));
        this.sc_server.on('disconnection', this.disconnectionHandler.bind(this));
        this.sc_server.on('closure', this.closureHandler.bind(this));
        this.sc_server.on('subscription', this.subscriptionHandler.bind(this));
        this.sc_server.on('unsubscription', this.unsubscriptionHandler.bind(this));
        this.sc_server.on('authentication', this.authenticationHandler.bind(this));
        this.sc_server.on('deauthentication', this.deauthenticationHandler.bind(this));
        this.sc_server.on('authenticationStateChange', this.authenticationStateChangeHandler.bind(this));
        this.sc_server.on('badSocketAuthToken', this.badSocketAuthTokenHandler.bind(this));
        this.sc_server.on('ready', this.readyHandler.bind(this));
    }

    /**
     * This gets triggered when fatal error occurs on this worker.
     * @param error
     */
    errorHandler(error){
        log.error(`Error in socket cluster server`);
        log.error(error);
    }

    /**
     * 	A notice carries potentially useful information but isn't quite an error.
     * @param notice
     */
    noticeHandler(notice){
        log.info(`Socket cluster server is on notice.`);
        log.info(inspect(notice));
    }

    /**
     * Emitted as soon as a new SCSocket object is created on the server - This occurs at the beginning of the client handshake, before the 'connection' event.
     The argument passed to the listener is the socket object which is performing the handshake. You should not try to send events to the socket while it is in this state.
     * @param socket
     */
    handshakeHandler(socket){

    }

    /**
     * Emitted whenever a socket becomes disconnected during the handshake phase. The listener to this event receives a socket (SCSocket) object as argument.
     * @param socket
     */
    connectionAbortHandler(socket){
        log.debug('Connection was aborted');
    }

    /**
     * Emitted whenever a new socket connection is established with the server (and the handshake has completed).
     * The listener to this event receives a socket (SCSocket) object as argument which can be used to interact with that client.
     * The second argument to the handler is the socket connection status object.
     * @param socket
     * @param status
     */
    async connectionHandler(socket, status) {
        // we need to allow connections from localhost as that is likely the hdb_client connecting
        if(!(await hdb_license.getLicense()).enterprise && !socket.remoteAddress.includes(terms.LOOPBACK)) {
            //let conn_count = this.sc_server.clientsCount;
            let client_keys = Object.keys(this.sc_server.clients);
            let external_conn_count = 0;
            for(let i=0; i<client_keys.length; ++i) {
                let client = this.sc_server.clients[client_keys[i]];
                if(this.sc_server.clients[client_keys[i]].remoteAddress.includes(terms.LOOPBACK)) {
                    continue;
                }
                external_conn_count++;
            }
            let conn_count = external_con_count;
            log.debug(`There are ${external_con_count} clients in the server.`);
            // check outbound node_connector connections
            try {
                let clients = this.worker.node_connector.connections.clients;
                if (clients) {
                    log.debug(`There are ${Object.keys(clients).length} node connector connections in the worker.`);
                    conn_count += Object.keys(clients).length;
                }
            } catch(err) {
                log.info('Could not count outbound node connections');
                log.error(err);
            }
            // if at max connections, reject
            if(conn_count >= terms.BASIC_LICENSE_MAX_CLUSTER_CONNS) {
                log.notify(`Rejected inbound connection, your license only supports 3 connections, you have ${conn_count}`);
                return socket.disconnect(terms.BASIC_LICENSE_CLUSTER_CONNECTION_LIMIT_WS_ERROR_CODE, `Rejected inbound connection, your license only supports 3 connections.  I have ${conn_count}`);
            }
        }
        new ServerSocket(this.worker, socket);
        log.info('socket connected: ' + socket.remoteAddress);
        if(socket.request.url === '/socketcluster/?hdb_worker=1'){
            try {
                this.worker.exchange_set([terms.INTERNAL_SC_CHANNELS.HDB_WORKERS, socket.id], 1).then(data => {
                    this.worker.exchange_get(terms.INTERNAL_SC_CHANNELS.HDB_WORKERS).then(data => {
                        let room_msg = new RoomMessageObjects.WatchHdbWorkersMessage();
                        room_msg.workers = Object.keys(data);
                        this.worker.exchange.publish(terms.INTERNAL_SC_CHANNELS.HDB_WORKERS, room_msg);
                    });
                });
            } catch(e){
                log.error(e);
            }
        }
    }

    /**
     * Emitted whenever a connected socket becomes disconnected (after the handshake phase).
     * The listener to this event receives a socket (SCSocket) object as argument.
     * Note that if the socket connection was not fully established (e.g. during the SC handshake phase), then the 'connectionAbort' event will be triggered instead.
     */
    disconnectionHandler(socket){
        //add logic for unsubscribe to hdb_worker channel
        if(socket.request.url === '/socketcluster/?hdb_worker=1'){
            this.worker.exchange_remove([terms.INTERNAL_SC_CHANNELS.HDB_WORKERS, socket.id]).then(data => {
                this.worker.exchange_get(terms.INTERNAL_SC_CHANNELS.HDB_WORKERS).then(data=> {
                    let room_msg = new RoomMessageObjects.WatchHdbWorkersMessage();
                    room_msg.workers = Object.keys(data);
                    this.worker.exchange.publish(terms.INTERNAL_SC_CHANNELS.HDB_WORKERS, room_msg);
                });
            });
        }
    }

    /**
     * Emitted whenever a connected socket becomes disconnected (at any stage of the handshake/connection cycle).
     * The listener to this event receives a socket (SCSocket) object as argument.
     * Note that this event is a catch-all for both 'disconnection' and 'connectionAbort' events.
     * @param socket
     */
    closureHandler(socket){

    }

    /**
     * Emitted whenever a socket connection which is attached to the server becomes subscribed to a channel.
     * The listener to this event receives a socket (SCSocket) object as the first argument. The second argument is the channelName. The third argument is the channelOptions object.
     * @param socket
     * @param channelName
     * @param channelOptions
     */
    subscriptionHandler(socket, channelName, channelOptions){

    }

    /**
     * Emitted whenever a socket connection which is attached to the server becomes unsubscribed from a channel. The listener to this event receives a socket (SCSocket) object as the first argument. The second argument is the channelName.
     * @param socket
     */
    unsubscriptionHandler(socket){

    }

    /**
     * Emitted whenever a socket connection which is attached to the server becomes authenticated. The listener to this event receives a socket (SCSocket) object as the first argument. The second argument is the authToken object.
     * @param socket
     * @param authToken
     */
    authenticationHandler(socket, authToken){

    }

    /**
     * Emitted whenever a socket connection which is attached to the server becomes deauthenticated.
     * The listener to this event receives a socket (SCSocket) object as the first argument.
     * The second argument is the old authToken object (before the deauthentication took place).
     * @param socket
     * @param oldAuthToken
     */
    deauthenticationHandler(socket, oldAuthToken){

    }

    /**
     * Triggers whenever the authState of a socket which is attached to the server changes (e.g. transitions between authenticated and unauthenticated states).
     * @param socket
     */
    authenticationStateChangeHandler(socket){

    }

    /**
     * Emitted when a client which is attached to the server tries to authenticate itself with an invalid (or expired) token.
     * The first argument passed to the handler is the socket object which failed authentication. The second argument is an object with the properties authError and signedAuthToken.
     * The authError is an error object and the signedAuthToken is the auth token which failed the verification step.
     * @param socket
     * @param authError
     */
    badSocketAuthTokenHandler(socket, authError){

    }

    /**
     * Emitted when the server is ready to accept connections.
     */
    readyHandler(){
        log.notify('The socket cluster server is ready.');
    }
}

module.exports = SCServer;