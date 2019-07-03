const SocketConnector = require('./SocketConnector');
const sc_util = require('../util/socketClusterUtils');
const log = require('../../../utility/logging/harper_logger');

class InterNodeSocketConnector extends SocketConnector{
    constructor(socket_client, additional_info, options, credentials, connection_timestamps){
        super(socket_client, additional_info, options, credentials);
        this.socket.additional_info.connected_timestamp = connection_timestamps[this.socket.clientId];
        this.addEventListener('connect', this.connectHandler.bind(this));

    }

    connectHandler(status){
        if(this.socket.additional_info && this.socket.additional_info.connected_timestamp){
            //check subscriptions so we can locally fetch catchup and ask for remote catchup
            this.additional_info.subscriptions.forEach(async (subscription) => {
                if (subscription.publish === true) {
                    try{
                        await sc_util.catchupHandler(subscription.channel, this.additional_info.connected_timestamp, null, this.socket);
                    } catch(e){
                        log.error(e);
                    }
                } else if(subscription.subscribe === true){
                    //TODO discuss with eli how to handle this in a room rather than an emit
                    this.socket.emit('catchup', {channel: subscription.channel, milis_since_connected: Date.now() - this.socket.additional_info.connected_timestamp});
                }
            });
        }
    }

}

module.exports = InterNodeSocketConnector;