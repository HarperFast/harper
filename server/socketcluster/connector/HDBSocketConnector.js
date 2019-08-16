const SocketConnector = require('./SocketConnector');
//const get_operation_function = require('../../serverUtilities').getOperationFunction;
const server_utilities = require('../../serverUtilities');
const log = require('../../../utility/logging/harper_logger');
const terms = require('../../../utility/hdbTerms');
const ClusterStatusEmitter = require('../../../events/ClusterStatusEmitter');
const {promisify, inspect} = require('util');
const global_schema = require('../../../utility/globalSchema');

const p_set_schema_to_global = promisify(global_schema.setSchemaDataToGlobal);

const ENTITY_TYPE_ENUM = {
    SCHEMA: `schema`,
    TABLE: `table`,
    ATTRIBUTE: `attribute`
};

class HDBSocketConnector extends SocketConnector{
    constructor(socket_client, additional_info, options, credentials){
        super(socket_client, additional_info, options, credentials);
        this.addEventListener('connect', this.connectHandler.bind(this));
        this.addEventListener('disconnect', this.disconnectHandler.bind(this));
    }

    connectHandler(status){
        // TODO: The worker watch function is now async, may need to callbackify this.
        this.subscribe(this.socket.id, this.hdbWorkerWatcher.bind(this));
    }

    disconnectHandler(status){
        log.debug(`worker_${process.pid} disconnected with status: ${status}`);
    }

    // When a response is sent from clustering, it ends up here.
    async hdbWorkerWatcher(req) {
        try {
            // Assume the message contains an operation, but in the case of cluster status we need to act a little differently.
            if(req.type) {
                switch(req.type) {
                    case terms.CLUSTERING_MESSAGE_TYPES.CLUSTER_STATUS_RESPONSE: {
                        ClusterStatusEmitter.clusterEmitter.emit(ClusterStatusEmitter.EVENT_NAME, req);
                        break;
                    }
                    case terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION: {
                        log.trace(`Received transaction message with operation: ${req.transaction.operation}`);
                        log.trace(`request: ${inspect(req)}`);
                        if(req && req.catchup_schema) {
                            await this.compareSchemas(req.catchup_schema);
                        }
                        let {operation_function} = server_utilities.getOperationFunction(req.transaction);
                        const async_func = promisify(operation_function);
                        let result = await async_func(req.transaction);
                        log.debug(result);
                        break;
                    }
                    default: {
                        log.info('Invalid message type in hdbWorkerWatcher.');
                        break;
                    }
                }
            } else {
                let {operation_function} = server_utilities.getOperationFunction(req);
                operation_function(req, (err, result) => {
                    //TODO possibly would be good to have a queue on the SC side holding pending transactions, on error we send back stating a fail.
                    if (err) {
                        log.error(err);
                    } else {
                        log.debug(result);
                    }
                });
            }
        } catch(e){
            log.error(e);
        }
    }

    /**
     * Compare the schemas stored in global.hdb_schema vs the schemas contained in the catchup response.  Create anything missing.
     * @param message_schema_object
     * @returns {Promise<void>}
     */
    async compareSchemas(message_schema_object) {
        if(!message_schema_object) {
            let msg = 'Invalid parameter in compareSchemas';
            log.error(msg);
        }
        try {
            if (!global.hdb_schema) {
                try {
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
                    let result = await async_func(msg);
                    // need to wait for the schema to be added to global.hdb_schema, or compareTableKeys will fail.
                    await p_set_schema_to_global();
                }
                // no point in doing system schema.
                if(curr_schema_name !== terms.SYSTEM_SCHEMA_NAME) {
                    await this.compareTableKeys(message_schema_object[curr_schema_name], curr_schema_name);
                }
            }
        } catch(err) {
            log.error('Error comparing schemas.');
            log.error(err);
        }
    }

    async compareTableKeys(schema_object, schema_name) {
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
                api_msg.operation = terms.OPERATIONS_ENUM.CREATE_SCHEMA;
                api_msg.schema = target_schema_name;
                log.trace(`Generated create schema call`);
                break;
            case ENTITY_TYPE_ENUM.TABLE:
                api_msg.operation = terms.OPERATIONS_ENUM.CREATE_TABLE;
                api_msg.schema = target_schema_name;
                api_msg.table = target_table_name;
                api_msg.hash_attribute = new_entity_object.hash_attribute;
                log.trace(`Generated create table call`);
                break;
            case ENTITY_TYPE_ENUM.ATTRIBUTE:
                api_msg.operation = terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE;
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

    async invokeOperation(operation_msg) {

    }
}

module.exports = HDBSocketConnector;