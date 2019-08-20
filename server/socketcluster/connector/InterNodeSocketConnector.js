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
const global_schema = require('../../../utility/globalSchema');
const p_set_schema_to_global = promisify(global_schema.setSchemaDataToGlobal);
const server_utilities = require('../../../server/serverUtilities');

const CATCHUP_INTERVAL = 10000;
const WORKER_RESPONSE_HANDLER = 1000;

const ENTITY_TYPE_ENUM = {
    SCHEMA: `schema`,
    TABLE: `table`,
    ATTRIBUTE: `attribute`
};

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

    async connectHandler(status) {
        try {
            // we always want to keep all schema/table/attribute info up to date, so always make a schema catchup request.
            let schema_catch_up_msg = await sc_util.schemaCatchupHandler();
            if (schema_catch_up_msg) {
                this.socket.publish(hdb_terms.INTERNAL_SC_CHANNELS.SCHEMA_CATCHUP, schema_catch_up_msg);
            }
            if (this.additional_info && this.connected_timestamp) {
                //check subscriptions so we can locally fetch catchup and ask for remote catchup
                this.additional_info.subscriptions.forEach(async (subscription) => {
                    if (subscription.publish === true) {
                        try {
                            let catch_up_msg = await sc_util.catchupHandler(subscription.channel, this.connected_timestamp, null);
                            if (catch_up_msg) {
                                this.socket.publish(hdb_terms.INTERNAL_SC_CHANNELS.CATCHUP, catch_up_msg);
                            }
                        } catch (e) {
                            log.error(e);
                        }
                    }
                    if (subscription.subscribe === true) {
                        //TODO correct the emits with CORE-402
                        this.socket.emit('catchup', {
                            channel: subscription.channel,
                            milis_since_connected: Date.now() - this.connected_timestamp
                        }, this.catchupResponseHandler.bind(this));
                    }
                });
            }

            this.interval_id = setInterval(this.recordConnectionTimestamp.bind(this), CATCHUP_INTERVAL);
        } catch(err) {
            log.error('Error during catchup handler.');
            log.error(err);
        }
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

    async catchupResponseHandler(error, catchup_msg) {
        log.debug('Received catchup message');
        if(error) {
            log.info('Error in catchupResponseHandler');
            log.error(error);
            return;
        }

        if(!catchup_msg) {
            log.info('empty catchup response message');
            return;
        }

        while(this.worker.hdb_workers.length === 0){
            await p_settimeout(WORKER_RESPONSE_HANDLER);
        }

        try {
            let req = {
                channel: hdb_terms.INTERNAL_SC_CHANNELS.CATCHUP,
                data: catchup_msg,
                hdb_header: {}
            };

            log.debug('Sending catchup message to hdb child.');
            let assign = new AssignToHdbChild();
            assign.evaluateRule(req, null, this.worker).then(()=>{});
        } catch (e) {
            log.error(e);
        }
    }

    async compareSchemas(message_schema_object) {
        log.trace('in compareSchema');
        if(!message_schema_object) {
            let msg = 'Invalid parameter in compareSchemas';
            log.error(msg);
        }
        try {
            if (!global.hdb_schema) {
                try {
                    log.info('Empty global schema, setting schema.');
                    await p_set_schema_to_global();
                } catch (err) {
                    log.error(`Error settings schema to global.`);
                    log.error(err);
                }
            }
            let schema_keys = Object.keys(message_schema_object);
            for(let i=0; i<schema_keys.length; i++) {
                let curr_schema_name = schema_keys[i];
                if(!global.hdb_schema[curr_schema_name]) {
                    let msg = this.generateOperationFunctionCall(ENTITY_TYPE_ENUM.SCHEMA, message_schema_object[curr_schema_name], curr_schema_name);
                    let {operation_function} = server_utilities.getOperationFunction(msg);
                    const async_func = promisify(operation_function);
                    log.trace('Calling operation in compare schema');
                    let result = await async_func(msg);
                    // need to wait for the schema to be added to global.hdb_schema, or compareTableKeys will fail.
                    await p_set_schema_to_global();
                }
                // no point in doing system schema.
                if(curr_schema_name !== hdb_terms.SYSTEM_SCHEMA_NAME) {
                    await this.compareTableKeys(message_schema_object[curr_schema_name], curr_schema_name);
                }
            }
        } catch(err) {
            log.error('Error comparing schemas.');
            log.error(err);
        }
    }
}

module.exports = InterNodeSocketConnector;