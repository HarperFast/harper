const SocketConnector = require('./SocketConnector');
const sc_util = require('../util/socketClusterUtils');
const log = require('../../../utility/logging/harper_logger');
const AssignToHdbChild = require('../decisionMatrix/rules/AssignToHdbChildWorkerRule');
const hdb_terms = require('../../../utility/hdbTerms');
const env = require('../../../utility/environment/environmentManager');
env.initSync();
const hdb_clustering_connections_path = env.getHdbBasePath() + '/clustering/connections/';
const fs = require('fs-extra');
const promisify = require('util').promisify;
const p_settimeout = promisify(setTimeout);

class InterNodeSocketConnector extends SocketConnector{
    constructor(socket_client, worker, additional_info, options, credentials){
        super(socket_client, additional_info, options, credentials);
        //TODO possibly change this to the node name, rather hostname / port?
        this.connection_path = hdb_clustering_connections_path + this.socket.options.hostname + ':' + this.socket.options.port;
        this.worker = worker;
    }

    async initialize(){
        try {
            this.connected_timestamp = (await fs.readFile(this.connection_path)).toString();
        } catch(e){
            if(e.code !== 'ENOENT') {
                log.error(e);
            }
        }
        this.addEventListener('connect', this.connectHandler.bind(this));
        this.addEventListener('disconnect', this.disconnectHandler.bind(this));
        this.addEventListener('catchup_response', this.catchupResponseHandler.bind(this));
    }

    connectHandler(status){
        if(this.additional_info && this.connected_timestamp){
            //check subscriptions so we can locally fetch catchup and ask for remote catchup
            this.additional_info.subscriptions.forEach(async (subscription) => {
                if (subscription.publish === true) {
                    try{
                        let catch_up_msg = await sc_util.catchupHandler(subscription.channel, parseInt(this.connected_timestamp));
                        if(catch_up_msg) {
                            this.socket.publish(hdb_terms.INTERNAL_SC_CHANNELS.CATCHUP, catch_up_msg);
                        }
                    } catch(e){
                        log.error(e);
                    }
                } else if(subscription.subscribe === true){
                    //TODO correct the emits with CORE-402
                    this.socket.emit('catchup', {channel: subscription.channel, milis_since_connected: Date.now() - this.connected_timestamp}, this.catchupResponseHandler.bind(this));
                }
            });
        }

        this.interval_id = setInterval(this.recordConnectionTimestamp.bind(this), 10000);
    }

    disconnectHandler(){
        if(this.interval_id !== undefined){
            clearInterval(this.interval_id);
        }
    }

    async recordConnectionTimestamp(){
        if(this.socket.state === this.socket.OPEN && this.socket.authState === this.socket.AUTHENTICATED){
            this.connected_timestamp = Date.now();

            try {
                await fs.writeFile(this.connection_path, this.connected_timestamp);
            } catch(e){
                log.error(e);
            }
        }
    }

    async catchupResponseHandler(error, catchup_msg){
        if(error){
            log.error(error);
            return;
        }

        if(!catchup_msg){
            return;
        }

        while(this.worker.hdb_workers.length === 0){
            await p_settimeout(1000);
        }

        try {
            let req = {
                channel: hdb_terms.INTERNAL_SC_CHANNELS.CATCHUP,
                data: catchup_msg,
                hdb_header: {}
            };

            let assign = new AssignToHdbChild();
            assign.evaluateRule(req, null, this.worker).then(()=>{});
        } catch (e) {
            log.error(e);
        }
    }

}

module.exports = InterNodeSocketConnector;