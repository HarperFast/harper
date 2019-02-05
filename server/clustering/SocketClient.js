"use strict";

/**
 * The main purpose of socket client is to store all connection no matter which direction they go.
 *
 * @type {{addNode, configureCluster, removeNode, payloadHandler, clusterMessageHandler, authHeaderToUser}|*}
 */
const cluster_utilities = require('./clusterUtilities');
const server_utilities = require('../serverUtilities');
const harper_logger = require('../../utility/logging/harper_logger');
const ioc = require('socket.io-client');
const schema = require('../../data_layer/schema');
const _ = require('lodash');
const moment = require('moment');
const {inspect} = require('util');
const common_utils = require('../../utility/common_utils');
const terms = require('../../utility/hdbTerms');

const PropertiesReader = require('properties-reader');
let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));

const ALLOW_SELF_SIGNED_CERTS = hdb_properties.get(terms.HDB_SETTINGS_NAMES.ALLOW_SELF_SIGNED_SSL_CERTS);
const insert = require('../../data_layer/insert');
const uuidv4 = require('uuid/v1');
const {promisify} = require('util');
const cluster_handlers = require('./clusterHandlers');

const p_server_utilities_choose_operation = promisify(server_utilities.chooseOperation);
const p_server_utilities_proccess_delegated_transaction = promisify(server_utilities.proccessDelegatedTransaction);
const p_schema_describe_all = promisify(schema.describeAll);
const p_schema_create_schema = promisify(schema.createSchema);
const p_schema_create_table = promisify(schema.createTable);
const p_schema_create_attribute = promisify(schema.createAttribute);
const p_insert = insert.insert;

const WHITELISTED_ERRORS = 'already exists';
const ERROR_NO_HDB_USER = 'there is no hdb_user';

const ATTRIBUTE_INDEX = 2;
const TABLE_INDEX = 1;
const SCHEMA_INDEX = 0;

const CLIENT_CONNECTION_OPTIONS = {
    reconnectionDelay: 5000,
    reconnectionDelayMax: 20000,
    secure: true,
    reconnection: true,
    rejectUnauthorized :
        ((ALLOW_SELF_SIGNED_CERTS && ALLOW_SELF_SIGNED_CERTS.toString().toLowerCase() === 'true') ? false : true)
};

class SocketClient {
    constructor(node, other_node, direction_enum) {
        this.node = node;
        this.other_node = other_node;
        this.client = null;
        // The direction data is flowing regarding this node.
        this.direction = direction_enum;
    }

    /**
     * Disconnect the connection in this.other_node.  This is typically needed when a node has been removed from hdb_nodes.
     */
    disconnectNode() {
        if(!this.other_node || this.other_node.disconnected) {
            harper_logger.info('There is no connected client to disconnect');
            return;
        }
        harper_logger.info(`disconnecting node ${this.other_node.name}`);
        this.client.disconnect();
    }

    onConnectHandler() {
        harper_logger.info(`Handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.CONNECT}`);
        this.other_node.status = 'connected';

        harper_logger.info(`Client: Connected to port ${this.other_node.port} on host ${this.other_node.host}`);

        let node_info = {
            name: this.node.name,
            port: this.node.port
        };
        this.client.emit(terms.CLUSTER_EVENTS_DEFS_ENUM.IDENTIFY, node_info);
        harper_logger.debug(`Done handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.CONNECT}`);
    }

    onConnectErrorHandler(error) {
        harper_logger.info(`Handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.CONNECT_ERROR}`);
        harper_logger.debug('cannot connect to ' + this.other_node.name + ' due to ' + error);
        harper_logger.debug(`Done handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.CONNECT_ERROR}`);
    }

    onReconnectHandler(attempt_number) {
        harper_logger.info(`Handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.RECONNECT_ATTEMPT}`);
        harper_logger.debug(': attempting to connect to ' + JSON.stringify(this.other_node) + ' for the ' + attempt_number + ' time');
        harper_logger.debug(`Done handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.RECONNECT_ATTEMPT}`);
    }

    async onCatchupRequestHandler(msg){
        harper_logger.info(`Handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.CATCHUP_REQUEST} from: ${msg.name}`);
        await cluster_handlers.fetchQueue(msg, this.client);
        harper_logger.debug(`Done handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.CATCHUP_REQUEST}`);
    }

    async onCatchupHandler(queue) {
        harper_logger.info('catchup' + inspect(queue));

        harper_logger.debug(`calling onSchemaUpdateResponseHandler`);
        await this.onSchemaUpdateResponseHandler(queue.schema);
        harper_logger.debug(`done calling onSchemaUpdateResponseHandler`);
        if(!queue.queue) {
            harper_logger.debug(`Nothing in the queue, all done here`);
            return;
        }

        let the_client = this.client;
        let the_node = this.node;
        for (let item in queue.queue) {
            let json = queue.queue[item].body;
            try {
                json = await cluster_utilities.authHeaderToUser(json);

                if (!queue.queue[item].body.hdb_user) {
                    queue.queue[item].err = ERROR_NO_HDB_USER;
                    harper_logger.error(`${ERROR_NO_HDB_USER}: ` + JSON.stringify(json));
                    the_client.emit(terms.CLUSTER_EVENTS_DEFS_ENUM.ERROR, queue.queue[item]);
                } else {
                    let operation_function = await p_server_utilities_choose_operation(json);

                    queue.queue[item].node = the_node;
                    harper_logger.debug(`Calling delegate transaction on operation: ${operation_function}`);
                    await p_server_utilities_proccess_delegated_transaction(json, operation_function)
                        .catch(err => {
                            if (!checkWhitelistedErrors(err)) {
                                throw err;
                            }
                        });

                    harper_logger.debug(`Emitting ${terms.CLUSTER_EVENTS_DEFS_ENUM.CONFIRM_MSG} event.`);
                    the_client.emit(terms.CLUSTER_EVENTS_DEFS_ENUM.CONFIRM_MSG, queue.queue[item]);
                    harper_logger.debug(`DONE Emitting ${terms.CLUSTER_EVENTS_DEFS_ENUM.CONFIRM_MSG} event.`);
                }
            } catch (e) {
                harper_logger.error(e);
                queue.queue[item].err = e;
                the_client.emit(terms.CLUSTER_EVENTS_DEFS_ENUM.ERROR, queue.queue[item]);
            }
        }
        harper_logger.debug('finished catchup request');
    }

    async onSchemaUpdateResponseHandler(cluster_schema) {
        harper_logger.debug(`Handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.SCHEMA_UPDATE_RES}`);
        let my_schema;
        try {
            my_schema = await p_schema_describe_all({});


            let missing_schemas = [];
            let missing_tables = [];
            let missing_attributes = [];
            let residence_table_map = {};

            Object.keys(cluster_schema).forEach(function (this_schema) {
                if (!my_schema[this_schema]) {
                    missing_schemas.push(this_schema);
                    Object.keys(cluster_schema[this_schema]).forEach(function (table) {
                        missing_tables.push(this_schema + "." + table + "." + cluster_schema[this_schema][table].hash_attribute);
                        if (cluster_schema[this_schema][table].residence) {
                            residence_table_map[this_schema + "." + table] = [];
                            Object.keys(cluster_schema[this_schema][table].residence).forEach(function (r) {
                                residence_table_map[this_schema + "." + table].push(cluster_schema[this_schema][table].residence[r]);
                            });
                        }

                        Object.keys(cluster_schema[this_schema][table].attributes).forEach(function (attribute) {
                            missing_attributes.push(this_schema + "." + table + "." + cluster_schema[this_schema][table].attributes[attribute].attribute);
                        });
                    });

                } else {
                    Object.keys(cluster_schema[this_schema]).forEach(function (table) {
                        if (!my_schema[this_schema][table]) {
                            missing_tables.push(this_schema + "." + table + "." + cluster_schema[this_schema][table].hash_attribute);
                            if (cluster_schema[this_schema][table].residence) {
                                residence_table_map[this_schema + "." + table] = [];
                                Object.keys(cluster_schema[this_schema][table].residence).forEach(function (r) {
                                    residence_table_map[this_schema + "." + table].push(cluster_schema[this_schema][table].residence[r]);
                                });

                            }
                            Object.keys(cluster_schema[this_schema][table].attributes).forEach(function (attribute) {
                                missing_attributes.push(this_schema + "." + table + "." + cluster_schema[this_schema][table].attributes[attribute].attribute);

                            });

                        } else {
                            let their_attributes = [];
                            Object.keys(cluster_schema[this_schema][table].attributes).forEach(function (attribute) {
                                their_attributes.push(cluster_schema[this_schema][table].attributes[attribute].attribute);

                            });

                            let my_attributes = [];

                            Object.keys(my_schema[this_schema][table].attributes).forEach(function (attribute) {
                                my_attributes.push(my_schema[this_schema][table].attributes[attribute].attribute);
                            });

                            let missing_attrs = _.difference(their_attributes, my_attributes);
                            for (let attr in missing_attrs) {
                                missing_attributes.push(this_schema + "." + table + "." + missing_attrs[attr]);
                            }
                        }
                    });
                }
            });

            await createMissingSchemas(missing_schemas);

            await createMissingTables(missing_tables, residence_table_map);

            await createMissingAttributes(missing_attributes);
        } catch(e){
            return harper_logger.error(e);
        }
        harper_logger.debug(`Done handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.SCHEMA_UPDATE_RES}`);
    }

    async onMsgHandler(msg) {
        harper_logger.debug(`Handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.MESSAGE}`);
        try {
            harper_logger.info(`received by ${this.node.name} : msg = ${JSON.stringify(msg)}`);
            let the_client = this.client;
            let this_node = this.node;
            msg.body = await cluster_utilities.authHeaderToUser(msg.body);

            if (!msg.body.hdb_user) {
                harper_logger.info('there is no hdb_user: ' + JSON.stringify(msg.body));
            }

            let operation_function = await p_server_utilities_choose_operation(msg.body);

            let payload = {
                "id": msg.id,
                "error": null,
                "data": null,
                "node": this_node
            };

            //here we want to use the catch to attach the error to the payload and then move on to allow the payload to be emitted
            let data = await p_server_utilities_proccess_delegated_transaction(msg.body, operation_function)
                .catch(err => {
                    harper_logger.error(err);
                    payload.error = err;
                });

            payload.data = data;
            the_client.emit(terms.CLUSTER_EVENTS_DEFS_ENUM.CONFIRM_MSG, payload);
        } catch(e){
            harper_logger.error(e);
        }
        harper_logger.debug(`Done handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.MESSAGE}`);
    }

    onDisconnectHandler(reason) {
        harper_logger.debug(`Handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.DISCONNECT}`);
        this.other_node.status = 'disconnected';
        harper_logger.info(`server ${this.other_node.name} down`);
        harper_logger.debug(`Done handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.DISCONNECT}`);
    }

    async onConfirmMessageHandler(msg){
        harper_logger.debug(`Handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.CONFIRM_MSG}`);
        await cluster_handlers.onConfirmMessageHandler(msg);
        harper_logger.debug(`Done handling ${terms.CLUSTER_EVENTS_DEFS_ENUM.CONFIRM_MSG}`);
    }

    connectToNode() {
        if (this.node.port === this.other_node.port && this.other_node.host === this.node.host) {
            harper_logger.debug("cannot connect to thyself");
        }

        harper_logger.info(`${this.node.name} is attempting to connect to ${this.other_node.name} at ${this.other_node.host}:${this.other_node.port}`);
        this.client = ioc.connect(`https://${this.other_node.host}:${this.other_node.port}`, CLIENT_CONNECTION_OPTIONS);
    }


    createClientMessageHandlers() {
        this.client.on(terms.CLUSTER_EVENTS_DEFS_ENUM.CONNECT, this.onConnectHandler.bind(this));

        this.client.on(terms.CLUSTER_EVENTS_DEFS_ENUM.RECONNECT_ATTEMPT, this.onReconnectHandler.bind(this));

        this.client.on(terms.CLUSTER_EVENTS_DEFS_ENUM.CONNECT_ERROR, this.onConnectErrorHandler.bind(this));

        this.client.on(terms.CLUSTER_EVENTS_DEFS_ENUM.CATCHUP_RESPONSE, this.onCatchupHandler.bind(this));

        this.client.on(terms.CLUSTER_EVENTS_DEFS_ENUM.CATCHUP_REQUEST, this.onCatchupRequestHandler.bind(this));

        this.client.on(terms.CLUSTER_EVENTS_DEFS_ENUM.CONFIRM_MSG, this.onConfirmMessageHandler.bind(this));

        this.client.on(terms.CLUSTER_EVENTS_DEFS_ENUM.SCHEMA_UPDATE_RES, this.onSchemaUpdateResponseHandler.bind(this));

        this.client.on(terms.CLUSTER_EVENTS_DEFS_ENUM.MESSAGE, this.onMsgHandler.bind(this));

        this.client.on(terms.CLUSTER_EVENTS_DEFS_ENUM.DISCONNECT, this.onDisconnectHandler.bind(this));
    }

    async send(msg) {
        let the_client = this.client;
        try {
            delete msg.body.hdb_user;
            if (!msg.id)
                msg.id = uuidv4();

            let payload = {"body": msg.body, "id": msg.id};

            if (!global.cluster_queue[this.other_node.name]) {
                global.cluster_queue[this.other_node.name] = {};
            }
            global.cluster_queue[this.other_node.name][payload.id] = payload;
            let results = await cluster_handlers.addToHDBQueue({
                "payload": payload,
                "id": payload.id,
                "node": msg.node,
                "timestamp": moment.utc().valueOf(),
                "node_name": msg.node.name
            });

            if(!common_utils.isEmpty(results)) {
                the_client.emit(terms.CLUSTER_EVENTS_DEFS_ENUM.MESSAGE, payload);
            }
        } catch (e) {
            harper_logger.error(e);
        }
    }
}

async function createMissingSchemas(missing_schemas){
    await Promise.all(missing_schemas.map(async (this_schema) => {
        await p_schema_create_schema({"schema": this_schema})
            .catch(err=>{
                if(err !== 'schema already exists') {
                    throw err;
                }
            });
    }));
}

async function createMissingTables(missing_tables, residence_table_map){
    await Promise.all(missing_tables.map(async(table) =>{
        let tokens = table.split(".");
        let table_create_object = {
            "schema": tokens[SCHEMA_INDEX],
            "table":tokens[TABLE_INDEX],
            "hash_attribute":tokens[ATTRIBUTE_INDEX]
        };
        if(residence_table_map[tokens[0] + "." + tokens[1]]){
            table_create_object.residence = residence_table_map[tokens[0] + "." + tokens[1]];
        }

        await p_schema_create_table(table_create_object)
            .catch(err=>{
                if(err !== `table ${table_create_object.table} already exists in schema ${table_create_object.schema}`){
                    throw err;
                }
            });
    }));
}

async function createMissingAttributes(missing_attributes) {
    await Promise.all(missing_attributes.map(async(attribute) =>{
        try {
            let tokens = attribute.split(".");
            let attr_create_object = {
                "schema": tokens[SCHEMA_INDEX],
                "table": tokens[TABLE_INDEX],
                "attribute": tokens[ATTRIBUTE_INDEX]
            };

            await p_schema_create_attribute(attr_create_object)
                .catch(err =>{
                    if(WHITELISTED_ERRORS.indexOf(err) < 0) {
                        throw err;
                    }
                });
        } catch(e){
            harper_logger.error('failed to create missing attribute: ' + attribute + ' due to ' + e );
            throw e;
        }
    }));
}

function checkWhitelistedErrors(error) {
    let error_msg = '';
    if(common_utils.isEmpty(error)){
        return true;
    }

    if(typeof error === 'string'){
        error_msg = error;
    }

    if(typeof error === 'object'){
        try {
            error_msg = JSON.stringify(error);
        } catch(e){
            harper_logger.error(e);
            return false;
        }
    }

    if(error_msg.includes(WHITELISTED_ERRORS)) {
        return true;
    }

    return false;
}

module.exports = SocketClient;
