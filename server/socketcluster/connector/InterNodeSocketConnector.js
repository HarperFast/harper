const SocketConnector = require('./SocketConnector');
const CatchUp = require('../handlers/CatchUp');
const env = require('../../../utility/environment/environmentManager');
const hdb_terms = require('../../../utility/hdbTerms');
env.initSync();
const hdb_queue_path = env.getHdbBasePath() + '/schema/system/hdb_queue/';

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
                    let catchup = new CatchUp(hdb_queue_path + subscription.channel, this.socket.additional_info.connected_timestamp);
                    await catchup.run();

                    if(Array.isArray(catchup.results) && catchup.results.length > 0) {
                        let catchup_response = {
                            channel: subscription.channel,
                            operation:'catchup',
                            transactions: catchup.results,
                            __transacted: true
                        };

                        this.socket.publish(hdb_terms.INTERNAL_SC_CHANNELS.CATCHUP, catchup_response);
                    }
                } else if(subscription.subscribe === true){
                    this.socket.emit('catchup', {channel: subscription.channel, milis_since_connected: Date.now() - this.socket.additional_info.connected_timestamp});
                }
            });
        }
    }

}

module.exports = InterNodeSocketConnector;