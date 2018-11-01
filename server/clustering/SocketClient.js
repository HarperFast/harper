"use strict";
const server_utilities = require('../serverUtilities');
const harper_logger = require('../../utility/logging/harper_logger');
const ioc = require('socket.io-client');
const schema = require('../../data_layer/schema');
const _ = require('lodash');
const async = require('async');
const auth = require('../../security/auth');
const common_utils = require('../../utility/common_utils');
const terms = require('../../utility/hdbTerms');

const PropertiesReader = require('properties-reader');
let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));

const ALLOW_SELF_SIGNED_CERTS = hdb_properties.get(terms.HDB_SETTINGS_NAMES.ALLOW_SELF_SIGNED_SSL_CERTS);

const WHITELISTED_ERRORS = ['attribute already exists'];
const ERROR_NO_HDB_USER = 'there is no hdb_user';

class SocketClient {
    constructor(node, other_node) {
        this.node = node;
        this.other_node = other_node;
        this.client = null;
    }

    onConnectHandler(){
        this.other_node.status = 'connected';

        harper_logger.info('Client: Connected to port ' + this.other_node.port);
        this.client.emit('identify', this.node.name);
        this.client.emit('schema_update_request');
    }

    onConnectErrorHandler(error){
        harper_logger.error('cannot connect to ' + this.other_node.name + ' due to ' + error);
    }

    onCatchupHandler(queue_string) {
        harper_logger.info('catchup' + queue_string);
        let queue = JSON.parse(queue_string);
        for (let item in queue) {

            let json = queue[item].body;
            let the_client = this.client;
            let the_node = this.node;
            authHeaderToUser(json, (error)=> {
                if (error) {
                    queue[item].err = error;
                    the_client.emit('error', queue[item]);
                    return harper_logger.error(error);
                }

                if(!queue[item].body.hdb_user){
                    queue[item].err = ERROR_NO_HDB_USER;
                    harper_logger.error(`${ERROR_NO_HDB_USER}: ` + JSON.stringify(json));
                    the_client.emit('error', queue[item]);
                } else {

                    server_utilities.chooseOperation(json, function (err, operation_function) {
                        if (err) {
                            queue[item].err = err;
                            the_client.emit('error', queue[item]);
                            return harper_logger.error(err);
                        }

                        server_utilities.proccessDelegatedTransaction(json, operation_function, function (err, result) {
                            queue[item].node = the_node;
                            if (err && !checkWhitelistedErrors(err)) {
                                queue[item].err = err;
                                the_client.emit('error', queue[item]);
                                return harper_logger.error(err);
                            }

                            the_client.emit('confirm_msg', queue[item]);
                        });
                    });
                }
            });
        }
    }

    onSchemaUpdateResponseHandler(cluster_schema){
        schema.describeAll(null, function(err, my_schema){
            let missing_schemas = [];
            let missing_tables = [];
            let missing_attributes = [];
            let residence_table_map = {};

            Object.keys(cluster_schema).forEach(function(this_schema) {
                if (!my_schema[this_schema]) {
                    missing_schemas.push(this_schema);
                    Object.keys(cluster_schema[this_schema]).forEach(function(table){
                        missing_tables.push(this_schema + "." + table + "." + cluster_schema[this_schema][table].hash_attribute);
                        if(cluster_schema[this_schema][table].residence){
                            residence_table_map[this_schema + "." + table] = [];
                            Object.keys(cluster_schema[this_schema][table].residence).forEach(function(r){
                                residence_table_map[this_schema + "." + table].push(cluster_schema[this_schema][table].residence[r])
                            });
                        }

                        Object.keys(cluster_schema[this_schema][table].attributes).forEach(function(attribute){
                            missing_attributes.push(this_schema + "." + table + "." + cluster_schema[this_schema][table].attributes[attribute].attribute);
                        });
                    });

                } else {
                    Object.keys(cluster_schema[this_schema]).forEach(function(table){
                        if (!my_schema[this_schema][table]) {
                            missing_tables.push(this_schema + "." + table + "." + cluster_schema[this_schema][table].hash_attribute);
                            if(cluster_schema[this_schema][table].residence){
                                residence_table_map[this_schema + "." + table] = [];
                                Object.keys(cluster_schema[this_schema][table].residence).forEach(function(r){
                                    residence_table_map[this_schema + "." + table].push(cluster_schema[this_schema][table].residence[r])
                                });

                            }
                            Object.keys(cluster_schema[this_schema][table].attributes).forEach(function(attribute){
                                missing_attributes.push(this_schema + "." + table + "." + cluster_schema[this_schema][table].attributes[attribute].attribute);

                            });

                        } else {
                            let their_attributes = [];
                            Object.keys(cluster_schema[this_schema][table].attributes).forEach(function(attribute){
                                their_attributes.push(cluster_schema[this_schema][table].attributes[attribute].attribute);

                            });

                            let my_attributes = [];

                            Object.keys(my_schema[this_schema][table].attributes).forEach(function(attribute){
                                my_attributes.push(my_schema[this_schema][table].attributes[attribute].attribute);
                            });

                            let missing_attrs = _.difference(their_attributes, my_attributes);
                            for(let attr in missing_attrs){
                                missing_attributes.push(this_schema + "." + table +"."+  missing_attrs[attr]);
                            }
                        }
                    });
                }
            });

            createMissingSchemas(missing_schemas, function(err, result){
                if(err){
                    return harper_logger.error(err);
                }
                createMissingTables(missing_tables, function(err, result){
                    if(err){
                        return harper_logger.error(err);
                    }

                    createMissingAttributes(missing_attributes, function(err, result){
                        if(err){
                            return harper_logger.error(err);
                        }
                    });
                });
            });

            function createMissingSchemas(missing_schemas, callback2){
                async.each(missing_schemas, function(this_schema, schema_callback) {
                    schema.createSchema({"schema": this_schema}, function(err, result){
                        if(err && err !== 'schema already exists'){
                            return schema_callback(err);
                        }
                        schema_callback(null, result);

                    });
                }, function(err) {
                    if(err){
                        return callback2(err);
                    }
                    return callback2();
                });
            }

            function createMissingTables(missing_tables, callback2){
                async.each(missing_tables, function(table, table_callback) {
                    let tokens = table.split(".");
                    let table_create_object = {
                        "schema": tokens[0],
                        "table":tokens[1],
                        "hash_attribute":tokens[2]
                    };
                    if(residence_table_map[tokens[0] + "." + tokens[1]]){
                        table_create_object.residence = residence_table_map[tokens[0] + "." + tokens[1]];
                    }
                    schema.createTable(table_create_object, function(err, result){
                        if(err && err !== `table ${table_create_object.table} already exists in schema ${table_create_object.schema}`){
                            return table_callback(err);
                        }
                        return table_callback(null, result);

                    });
                }, function(err) {
                    if(err){
                        return callback2(err);
                    }
                    return callback2();
                });
            }

            function createMissingAttributes(missing_attributes, callback2){


                async.each(missing_attributes, function(attribute, attr_callback) {
                    let tokens = attribute.split(".");
                    let attr_create_object = {
                        "schema": tokens[0],
                        "table":tokens[1],
                        "attribute":tokens[2]
                    };

                    schema.createAttribute(attr_create_object, function(err, result){
                        attr_callback(err, result);

                    });


                }, function(err) {
                    if(err){
                        return callback2(err);
                    }
                    return callback2();
                });
            }

        });

    }

    onConfirmIdentity(msg) {

    }

    onMsgHandler(msg) {
        harper_logger.info(`received by ${this.node.name} : msg = ${JSON.stringify(msg)}`);
        let the_client = this.client;
        let this_node = this.node;
        authHeaderToUser(msg.body, (error) => {
            if (error) {
                return harper_logger.error(error);
            }

            if (!msg.body.hdb_user) {
                harper_logger.info('there is no hdb_user: ' + JSON.stringify(msg.body));
            }

            server_utilities.chooseOperation(msg.body, (err, operation_function) => {
                server_utilities.proccessDelegatedTransaction(msg.body, operation_function, function (err, data) {
                    let payload = {
                        "id": msg.id,
                        "error": err,
                        "data": data,
                        "node": this_node
                    };
                    the_client.emit('confirm_msg', payload);
                });
            });
        });
    }

    onDisconnectHandler(reason) {
        this.other_node.status = 'disconnected';
        harper_logger.info(`server ${this.other_node.name} down`);
    }

    connectToNode() {
        if (this.node.port === this.other_node.port && this.other_node.host === this.node.host) {
            harper_logger.debug("cannot connect to thyself");
        }

        harper_logger.info(`${this.node.name} is attempting to connect to ${this.other_node.name} at ${this.other_node.host}:${this.other_node.port}`);
        let socket_options = { secure: true, reconnect: true, rejectUnauthorized :
                ((ALLOW_SELF_SIGNED_CERTS && ALLOW_SELF_SIGNED_CERTS.toString().toLowerCase() === 'true') ? true : false)
        };
        this.client = ioc.connect(`https://${this.other_node.host}:${this.other_node.port}`, socket_options);
    }

    createClientMessageHandlers(){
        this.client.on("connect", this.onConnectHandler.bind(this));

        this.client.on('connect_error', this.onConnectErrorHandler.bind(this));

        this.client.on('catchup', this.onCatchupHandler.bind(this));

        this.client.on('schema_update_response', this.onSchemaUpdateResponseHandler.bind(this));

        this.client.on('confirm_identity', this.onConfirmIdentity.bind(this));

        this.client.on('msg', this.onMsgHandler.bind(this));

        this.client.on('disconnect', this.onDisconnectHandler.bind(this));
    }
}

function authHeaderToUser(json_body, callback){
    let req = {};
    req.headers = {};
    req.headers.authorization = json_body.hdb_auth_header;

    auth.authorize(req, null, function (err, user) {
        if (err) {
            return callback(err);
        }

        json_body.hdb_user = user;

        callback(null, json_body);
    });
}

function checkWhitelistedErrors(error){
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

    for(let ok_msg in WHITELISTED_ERRORS){
        if(error_msg.includes(ok_msg)){
            return true;
        }
    }

    return false;
}


module.exports = SocketClient;