"use strict";
const log = require('../../../utility/logging/harper_logger');

class SocketConnector{
    /**
     *
     * @param socket_client
     * @param name
     * @param options
     * @param credentials
     */
    constructor(socket_client, additional_info, options, credentials){
        this.additional_info = additional_info;
        this.init(socket_client, options, credentials);
        this.disconnect_timestamp = null;
    }

    init(socket_client, options, credentials) {
        this.socket = socket_client.create(options);

        if(typeof this.additional_info === 'object'){
            this.socket.additional_info = this.additional_info;
        }

        this.socket.on('error', err =>{
            log.error('ERROR on HDB Client socket: ' + err);
            log.error(err);
        });

        this.socket.on('connect', status =>{
            this.disconnect_timestamp = null;
            log.info(status);
        });

        this.socket.on('disconnect', status =>{
            this.disconnect_timestamp = Date.now();
            log.error('Disconnected from cluster server.');
            log.error(status);
        });

        this.socket.on('login', (data, res)=>{
            log.debug('logging in');
            res(null, credentials);
        });
    }

    addEventListener(event, listener){
        this.socket.addEventListener(event, listener);
    }

    subscribe(channel, watcher){
        this.socket.subscribe(channel).watch(watcher);
    }

    publish(channel, data, handler){
        this.socket.publish(channel, data, handler);
    }

    emit(event, data){
        this.socket.emit(event, data);
    }

    status(){
        return {
            active: this.socket.active,
            state: this.socket.state,
            auth_state: this.socket.authState
        };
    }

    subscriptions(){
        return Object.keys(this.socket.subscriptions(true));
    }

    unsubscribe(channel){
        this.socket.unsubscribe(channel);
    }

    destroy(){
        this.socket.destroy();
    }
}

module.exports = SocketConnector;