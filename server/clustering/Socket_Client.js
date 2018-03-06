const server_utilities = require('../server_utilities'),
    winston = require('../../utility/logging/winston_logger'),
    retry = require('retry-as-promised'),
    ioc = require('socket.io-client'),
    schema = require('../../data_layer/schema'),
    _ = require('lodash');


class Socket_Client {
    constructor(node) {
        this.node = node;

    }

    establishConnections(next) {
        try {
            const async = require('async');

            let node = this.node;

            async.each(node.other_nodes, function (o_node, caller) {
                global.cluster_server.connectToNode(node, o_node, function (err) {
                    if (err) {
                       return caller(err);
                    }

                   return caller();

                });
            }, function (err) {
                if (err)
                    return next(err);

                return next();
            });
        } catch (e) {
            winston.error(e);
            next(e)
        }
    }


    connectToNode(node, o_node, callback) {
        if (node.port == o_node.port && o_node.host == node.host) {
            callback("cannot connect to thyself. ");
        }
        //TODO needs to be HTTPS
        winston.info(`${node.name} is attempting to connect to ${o_node.name} at ${o_node.host}:${o_node.port}`);
        var client = ioc.connect(`http://${o_node.host}:${o_node.port}`);

        client.on("connect", function () {
            o_node.status = 'connected';
            global.o_nodes[o_node.name] = o_node;

            winston.info('Client: Connected to port ' + o_node.port);
            client.emit('identify', node.name);
            client.emit('schema_update_request');
        });

        client.on('connect_error', (error) => {


        });

        client.on('catchup', function (queue_string) {
            winston.info('catchup' + queue_string);
            let queue = JSON.parse(queue_string);
            for (let item in queue) {
                server_utilities.chooseOperation(queue[item].body, function (err, operation_function) {
                    if (err) {
                        return winston.error(err);
                    }

                    server_utilities.proccessDelegatedTransaction(queue[item].body,
                        operation_function, function(err, result){
                            if(err){
                                client.emit('error', err);
                                return winston.error(err);
                            }
                            queue[item].node = global.cluster_server.socket_server.node;
                            client.emit('confirm_msg', queue[item]);
                        });
                });
            }
        });

        client.on('schema_update_response', function(cluster_schema){
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
                                for(attr in missing_attrs){
                                    missing_attributes.push(this_schema + "." + table +"."+  missing_attrs[attr]);
                                }
                            }
                        });
                    }
                });

                createMissingSchemas(missing_schemas, function(err, result){
                    if(err){
                        return console.error(err);
                    }
                    createMissingTables(missing_tables, function(err, result){
                        if(err){
                            return console.error(err);
                        }

                        createMissingAttributes(missing_attributes, function(err, result){
                            if(err){
                                return console.error(err);
                            }
                        });
                    });
                });

                function createMissingSchemas(missing_schemas, callback){
                    async.each(missing_schemas, function(this_schema, schema_callback) {
                        schema.createSchema({"schema": this_schema}, function(err, result){
                            if(err && err != 'schema already exists'){
                                return schema_callback(err);
                            }
                            schema_callback(null, result);

                        });
                    }, function(err) {
                        if(err){
                            return callback(err);
                        }
                        return callback();
                    });
                }

                function createMissingTables(missing_tables, callback){
                    async.each(missing_tables, function(table, table_callback) {
                        let tokens = table.split(".");
                        let table_create_object = {
                            "schema": tokens[0],
                            "table":tokens[1],
                            "hash_attribute":tokens[2]
                        }
                        if(residence_table_map[tokens[0] + "." + tokens[1]]){
                            table_create_object.residence = residence_table_map[tokens[0] + "." + tokens[1]];
                        }
                        schema.createTable(table_create_object, function(err, result){
                            if(err && err != `table ${table_create_object.table} already exists in schema ${table_create_object.schema}`){
                                return table_callback(err);
                            }
                            return table_callback(null, result);

                        });
                    }, function(err) {
                        if(err){
                            return callback(err);
                        }
                        return callback();
                    });
                }

                function createMissingAttributes(missing_attributes, callback){


                    async.each(missing_attributes, function(attribute, attr_callback) {
                        let tokens = attribute.split(".");
                        let attr_create_object = {
                            "schema": tokens[0],
                            "table":tokens[1],
                            "attribute":tokens[2]
                        }

                        schema.createAttribute(attr_create_object, function(err, result){
                            attr_callback(err, result);

                        })


                    }, function(err) {
                        if(err){
                            return callback(err);
                        }
                        return callback();
                    });
                }

            });

        });


        client.on('confirm_identity', function (msg) {

            callback();
        });

        client.on('msg', (msg, fn) => {
            winston.info(`received by ${node.name} : msg = ${JSON.stringify(msg)}`);
            server_utilities.chooseOperation(msg.body, (err, operation_function) => {
                server_utilities.proccessDelegatedTransaction(msg.body, operation_function, function (err, data) {
                    let payload = {
                        "id": msg.id,
                        "error": err,
                        "data": data,
                        "node": node
                    };
                    client.emit('confirm_msg', payload);
                });
            });
        });

        client.on('disconnect', function (reason) {
            o_node.status = 'disconnected';
            global.o_nodes[o_node.name] = o_node;
            winston.info(`server ${o_node.name} down`);
        });
    }
}


module.exports = Socket_Client;