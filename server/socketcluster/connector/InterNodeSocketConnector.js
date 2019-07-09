const SocketConnector = require('./SocketConnector');
const sc_util = require('../util/socketClusterUtils');
const log = require('../../../utility/logging/harper_logger');
const AssignToHdbChild = require('../decisionMatrix/rules/AssignToHdbChildWorkerRule');
const hdb_terms = require('../../../utility/hdbTerms');


class InterNodeSocketConnector extends SocketConnector{
    constructor(socket_client, worker, additional_info, options, credentials, connection_timestamps){
        super(socket_client, additional_info, options, credentials);
        this.worker = worker;
        this.socket.additional_info.connected_timestamp = connection_timestamps[this.socket.clientId];
        this.addEventListener('connect', this.connectHandler.bind(this));
        this.addEventListener('catchup_response', this.catchupResponseHandler.bind(this));
    }

    connectHandler(status){
        if(this.socket.additional_info && this.socket.additional_info.connected_timestamp){
            //check subscriptions so we can locally fetch catchup and ask for remote catchup
            this.additional_info.subscriptions.forEach(async (subscription) => {
                if (subscription.publish === true) {
                    try{
                        let catch_up_msg = await sc_util.catchupHandler(subscription.channel, this.additional_info.connected_timestamp, null);
                        this.socket.publish(hdb_terms.INTERNAL_SC_CHANNELS.CATCHUP, catch_up_msg);
                    } catch(e){
                        log.error(e);
                    }
                } else if(subscription.subscribe === true){
                    //TODO discuss with eli how to handle this in a room rather than an emit
                    this.socket.emit('catchup', {channel: subscription.channel, milis_since_connected: Date.now() - this.socket.additional_info.connected_timestamp}, this.catchupResponseHandler);
                }
            });
        }
    }

    catchupResponseHandler(error, catchup_msg){
        if(error){
            log.error(error);
            return;
        }

        try {
            catchup_msg.channel = hdb_terms.INTERNAL_SC_CHANNELS.CATCHUP;
            let assign = new AssignToHdbChild();
            assign.evaluateRule(catchup_msg, null, this.worker).then(()=>{});
        } catch (e) {
            log.error(e);
        }
    }

}

module.exports = InterNodeSocketConnector;