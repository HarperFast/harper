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

    connectHandler(status){
        if(this.additional_info && this.connected_timestamp){
            //check subscriptions so we can locally fetch catchup and ask for remote catchup
            this.additional_info.subscriptions.forEach(async (subscription) => {
                if(subscription.publish === true) {
                    try{
                        let catch_up_msg = await sc_util.catchupHandler(subscription.channel, this.connected_timestamp, null);
                        if(catch_up_msg) {
                            this.socket.publish(hdb_terms.INTERNAL_SC_CHANNELS.CATCHUP, catch_up_msg);
                        }
                    } catch(e){
                        log.error(e);
                    }
                } if(subscription.subscribe === true) {
                    //TODO correct the emits with CORE-402
                    this.socket.emit('catchup', {channel: subscription.channel, milis_since_connected: Date.now() - this.connected_timestamp}, this.catchupResponseHandler.bind(this));
                }
            });
        }

        this.interval_id = setInterval(this.recordConnectionTimestamp.bind(this), CATCHUP_INTERVAL);
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

            if(catchup_msg && catchup_msg.catchup_schema) {
                log.debug('Comparing catchup response schema to global.');
                await this.compareSchemas(req.catchup_schema);
            }

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

    async compareTableKeys(schema_object, schema_name) {
        log.trace('in compareTableKeys');
        if(!schema_object || !schema_name) {
            let msg = 'Invalid parameters in compareTableKeys.';
            log.error(msg);
            throw new Error(msg);
        }
        try {
            let table_keys = Object.keys(schema_object);
            for(let i=0; i<table_keys.length; i++) {
                let curr_table_name = table_keys[i];
                if(!global.hdb_schema[schema_name] || !global.hdb_schema[schema_name][curr_table_name]) {
                    let msg = this.generateOperationFunctionCall(ENTITY_TYPE_ENUM.TABLE, schema_object[curr_table_name], schema_name, curr_table_name);
                    let {operation_function} = server_utilities.getOperationFunction(msg);
                    const async_func = promisify(operation_function);
                    log.trace('Calling createTable');
                    let result = await async_func(msg);
                    // need to wait for the table to be added to global.hdb_schema, or compareAttributeKeys will fail.
                    await p_set_schema_to_global();
                }
                await this.compareAttributeKeys(schema_object[curr_table_name], schema_name, curr_table_name);
            }
        } catch(err) {
            log.error(err);
        }
    }

    /**
     * Compares the attributes with a table passed in with the matching table in global.hdb_schema.  If there are
     * additional attributes in the passed table object, each new attribute will be created.
     * @param table_object - A table description object
     * @param schema_name - The schema the specified table should reside in
     * @param table_name - The name of the table being compared.
     * @returns {Promise<void>}
     */
    async compareAttributeKeys(table_object, schema_name, table_name) {
        log.trace('In compareAttributeKeys');
        if(!table_object || !schema_name || !table_name) {
            throw new Error('Invalid parameter passed to compareAttributeKeys');
        }

        if(!global.hdb_schema[schema_name] || !global.hdb_schema[schema_name][table_name]) {
            throw new Error(`Schema:${schema_name} or table: ${table_name} not found in compareAttributeKeys`);
        }
        try {
            for(let i=0; i< table_object.attributes.length; i++) {
                let curr_attribute_name = table_object.attributes[i].attribute;
                // Attributes may not yet exist if this is a new table. If so,create the first one and then iterate in the
                // else statement for all the rest of the attributes
                if(!global.hdb_schema[schema_name][table_name].attributes) {
                    let msg = this.generateOperationFunctionCall(ENTITY_TYPE_ENUM.ATTRIBUTE, table_object.attributes[i], schema_name, table_name);
                    let {operation_function} = server_utilities.getOperationFunction(msg);
                    if(!msg || !operation_function) {
                        // OK to be caught locally, just want to exit processing.
                        throw new Error('Invalid operation function in compareAttributeKeys.');
                    }
                    log.trace('Calling create Attribute.');
                    const async_func = promisify(operation_function);
                    let result = await async_func(msg);
                } else {
                    let create_attribute = true;
                    if(!global.hdb_schema[schema_name][table_name].attributes) {
                        // should never get here, but log an error if we do
                        throw new Error(`attributes for schema: ${schema_name} and table: ${table_name} do not exist in compareAttributeKeys.`);
                    }
                    for(let i=0; i<global.hdb_schema[schema_name][table_name].attributes.length; i++) {
                        if(global.hdb_schema[schema_name][table_name].attributes[i].attribute === curr_attribute_name) {
                            // this attribute already exists, break out of the loop and move onto the next attribute.
                            create_attribute = false;
                            break;
                        }
                    }
                    if(create_attribute) {
                        log.trace(`compareAttributeKeys Creating attribute: ${table_object.attributes[i].attribute}`);
                        let msg = this.generateOperationFunctionCall(ENTITY_TYPE_ENUM.ATTRIBUTE, table_object.attributes[i], schema_name, table_name);
                        let {operation_function} = server_utilities.getOperationFunction(msg);
                        const async_func = promisify(operation_function);
                        try {
                            let result = await async_func(msg);
                        } catch(err) {
                            log.info(`There was a problem creating attribute ${msg.attribute}.  It probably already exists.`);
                            // no-op, some attributes may already exist so do nothing
                        }
                    }
                }
            }
        } catch(err) {
            log.error(`Failed to create attribute in table: ${table_name}`);
            log.error(err);
        }
    }

    /**
     This function generates an object that resembles an API message call in order to create schema/table/attributes that
     are found missing during a catchup call.  Using this allows us to avoid importing all the create functions and just
     use the api as it stands.
     **/
    generateOperationFunctionCall(entity_type_enum, new_entity_object, target_schema_name, target_table_name) {
        log.trace(`Processing generateOperationFunctionCall`);
        if(!entity_type_enum || !new_entity_object) {
            log.info(`Invalid parameter for getOperationFunctionCall`);
            return null;
        }
        let api_msg = {};
        switch(entity_type_enum) {
            case ENTITY_TYPE_ENUM.SCHEMA:
                api_msg.operation = hdb_terms.OPERATIONS_ENUM.CREATE_SCHEMA;
                api_msg.schema = target_schema_name;
                log.trace(`Generated create schema call`);
                break;
            case ENTITY_TYPE_ENUM.TABLE:
                api_msg.operation = hdb_terms.OPERATIONS_ENUM.CREATE_TABLE;
                api_msg.schema = target_schema_name;
                api_msg.table = target_table_name;
                api_msg.hash_attribute = new_entity_object.hash_attribute;
                log.trace(`Generated create table call`);
                break;
            case ENTITY_TYPE_ENUM.ATTRIBUTE:
                api_msg.operation = hdb_terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE;
                api_msg.schema = target_schema_name;
                api_msg.table = target_table_name;
                api_msg.attribute = new_entity_object.attribute;
                log.trace(`Generated create attribute call`);
                break;
            default:
                break;
        }
        return api_msg;
    }
}

module.exports = InterNodeSocketConnector;