const fs = require('fs.extra')
    , insert = require('./insert.js')
    , async = require('async')
    , validation = require('../validation/schema_validator.js')
    , search = require('./search.js')
    , winston = require('../utility/logging/winston_logger')
    , uuidV4 = require('uuid/v4')
    , delete_ = require('../data_layer/delete')
    //this is to avoid a circular dependency with insert.
    // insert needs the describe all function but so does this module.
    // as such the functions have been broken out into a separate module.
    , schema_describe = require('./schemaDescribe')
    , schema_ops = require('../utility/schema_ops')
    , PropertiesReader = require('properties-reader'),
    mkdirp = require('mkdirp'),
    signalling = require('../utility/signalling');
let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));


module.exports = {
    createSchema: createSchema,
    createSchemaStructure: createSchemaStructure,
    dropSchema: dropSchema,
    deleteSchemaStructure: deleteSchemaStructure,
    describeTable: schema_describe.describeTable,
    describeSchema: schema_describe.describeSchema,
    createTable: createTable,
    createTableStructure: createTableStructure,
    dropTable: dropTable,
    deleteTableStructure: deleteTableStructure,
    createAttribute: createAttribute,
    createAttributeStructure: createAttributeStructure,
    dropAttribute: dropAttribute,
    describeAll: schema_describe.describeAll
};


/** schema methods **/

function createSchema(schema_create_object, callback) {
    try {
        createSchemaStructure(schema_create_object, function (err, success) {
            if (err) {
                callback(err);
                return;
            }

            signalling.signalSchemaChange({type: 'schema'});
            addAndRemoveFromQueue(schema_create_object, success, callback);
        });
    } catch (e) {
        callback(e);
    }
}

function dropSchema(drop_schema_object, callback) {
    try {
        deleteSchemaStructure(drop_schema_object, function (err, success) {
            if (err) {
                callback(err);
                return;
            }
            signalling.signalSchemaChange({type: 'schema'});

            delete global.hdb_schema[drop_schema_object.schema];
            addAndRemoveFromQueue(drop_schema_object, success, callback);
        });
    } catch (e) {
        winston.error(e);
        return callback(e);
    }
}


function createSchemaStructure(schema_create_object, callback) {
    try {
        let validation_error = validation.schema_object(schema_create_object);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }

        searchForSchema(schema_create_object.schema, (err, schema) => {
            if (schema && schema.length > 0) {
                return callback(`Schema ${schema_create_object.schema} already exists`);
            }

            let insertObject = {
                operation: 'insert',
                schema: 'system',
                table: 'hdb_schema',
                records: [
                    {
                        name: schema_create_object.schema,
                        createddate: '' + Date.now()
                    }
                ]
            };

            insert.insert(insertObject, function (err, result) {
                if (err) {
                    callback(err);
                    return;
                }
                let schema = schema_create_object.schema;
                fs.mkdir(hdb_properties.get('HDB_ROOT') + '/schema/' + schema, function (err, data) {
                    if (err) {
                        if (err.errno === -17) {
                            callback("schema already exists", null);
                            return;

                        } else {
                            callback(err.message, null);
                            return;
                        }
                    }
                    callback(err, `schema ${schema_create_object.schema} successfully created`);
                });
            });
        });
    } catch (e) {
        callback(e);
    }
}

function deleteSchemaStructure(drop_schema_object, callback) {
    try {
        let validation_error = validation.schema_object(drop_schema_object);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }

        let schema = drop_schema_object.schema;
        let delete_schema_object = {
            table: "hdb_schema",
            schema: "system",
            hash_values: [schema]
        };

        delete_.delete(delete_schema_object, function (err, data) {
            if (err) {
                callback(err);
                return;
            }

            let search_obj = {
                schema: 'system',
                table: 'hdb_table',
                hash_attribute: 'id',
                search_attribute: 'schema',
                search_value: schema,
                get_attributes: ['id']
            };

            search.searchByValue(search_obj, function (err, tables) {
                if (err) {
                    callback(err);
                    return;
                }
                fs.rmrf(`${hdb_properties.get('HDB_ROOT')}/schema/${schema}`, function (err) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    if (tables && tables.length > 0) {
                        let delete_table_object = {
                            table: "hdb_table",
                            schema: "system",
                            hash_values: []
                        };

                        for (t in tables) {
                            delete_table_object.hash_values.push(tables[t].id);
                        }

                        delete_.delete(delete_table_object, function (err, data) {
                            if (err) {
                                callback(err);
                                return;
                            }

                            deleteAttributeStructure(drop_schema_object, function (err, data) {

                                if (err) {
                                    callback(err);
                                    return;
                                }
                               return callback(null, `successfully delete ${schema}`);
                            });
                        });
                    }else{
                        return callback(null, `successfully delete ${schema}`);
                    }
                });
            });
        });
    } catch (e) {
        winston.error(e);
        return callback(e);
    }
}

/** table methods **/

function createTableStructure(create_table_object, callback) {

    let validator = validation.create_table_object(create_table_object);
    if (validator) {
        callback(validator);
        return;
    }

    async.waterfall([
        searchForSchema.bind(null, create_table_object.schema),
        (schema, caller) => {
            if (!schema || schema.length === 0) {
                return caller(`schema ${create_table_object.schema} does not exist`);
            }

            caller();
        },
        searchForTable.bind(null, create_table_object.schema, create_table_object.table),
        (table, caller) => {
            if (table && table.length > 0) {
                return caller(`table ${create_table_object.table} already exists in schema ${create_table_object.schema}`);
            }

            caller();
        }
    ], (err) => {
        if (err) {
            return callback(err);
        }

        let table = {
            name: create_table_object.table,
            schema: create_table_object.schema,
            id: uuidV4(),
            hash_attribute: create_table_object.hash_attribute
        };

        let insertObject = {
            operation: 'insert',
            schema: 'system',
            table: 'hdb_table',
            hash_attribute: 'id',
            records: [table]
        };

        insert.insert(insertObject, function (err, result) {
            if (err) {
                callback(err);
                return;
            }

            fs.mkdir(hdb_properties.get('HDB_ROOT') + '/schema/' + create_table_object.schema + '/' + create_table_object.table, function (err, data) {
                if (err) {
                    if (err.errno === -2) {
                        callback("schema does not exist", null);
                        return;
                    }

                    if (err.errno === -17) {
                        callback("table already exists", null);
                        return;

                    } else {
                        callback('createTableStructure:' + err.message);
                        return
                    }
                }

                callback(null, `table ${create_table_object.schema}.${create_table_object.table} successfully created.`);
            });
        });
    });
}

function searchForSchema(schema_name, callback) {
    let search_obj = {
        schema: 'system',
        table: 'hdb_schema',
        get_attributes: ['name'],
        conditions: [{
            'and': {'=': ['name', schema_name]}
        }]
    };

    search.searchByConditions(search_obj, (err, data) => {
        if (err) {
            return callback(err);
        }

        callback(null, data);
    });
}

function searchForTable(schema_name, table_name, callback) {
    let search_obj = {
        schema: 'system',
        table: 'hdb_table',
        get_attributes: ['name'],
        conditions: [{
            'and': {'=': ['name', table_name]}
        },
            {
                'and': {'=': ['schema', schema_name]}
            }]
    };

    search.searchByConditions(search_obj, (err, data) => {
        if (err) {
            return callback(err);
        }

        callback(null, data);
    });
}

function deleteTableStructure(drop_table_object, callback) {
    try {
        let validation_error = validation.table_object(drop_table_object);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }
        let schema = drop_table_object.schema;
        let table = drop_table_object.table;
        let search_obj = {};
        search_obj.schema = 'system';
        search_obj.table = 'hdb_table';
        search_obj.hash_attribute = 'id';
        search_obj.search_attribute = 'name';
        search_obj.search_value = drop_table_object.table;
        search_obj.get_attributes = ['name', 'schema', 'id'];
        search.searchByValue(search_obj, function (err, data) {
            if (err) {
                callback(err);
                return;
            }

            let delete_tb = null;
            for (let item in data) {
                if (data[item].name === drop_table_object.table && data[item].schema === drop_table_object.schema) {
                    delete_tb = data[item];
                }
            }

            if (delete_tb) {
                let delete_table_object = {
                    table: "hdb_table",
                    schema: "system",
                    hash_attribute: "id",
                    hash_values: [delete_tb.id]
                };

                delete_.delete(delete_table_object, function (err, data) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    let path = `hdb_properties.get('HDB_ROOT')/schema/${schema}/${table}`;
                    let currDate = new Date().toISOString().substr(0,19);
                    let destination_name = `${table}-${currDate}`;
                    let trash_path = `${hdb_properties.get('HDB_ROOT')}/trash`;
                    //TODO: mkdirp defaults to 0777, we need to discuss what the best perms should be.
                    //mkdirp does nothing if the directory exists.
                    mkdirp(trash_path, function(err, data) {
                        if(err) {
                            return callback(err);
                        }
                        fs.move(`${hdb_properties.get('HDB_ROOT')}/schema/${schema}/${table}`,
                            `${hdb_properties.get('HDB_ROOT')}/trash/${destination_name}`, function (err) {
                            if (err) {
                                return callback(err);
                            }
                            deleteAttributeStructure(drop_table_object, function (err, data) {
                                if (err) {
                                    return callback(err);
                                }
                                callback(null, `successfully deleted ${table}`);
                            });
                        });
                    });
                });
            } else {
                callback("Table not found!");
            }
        });
    } catch (e) {
        callback(e);
    }
}

function createTable(create_table_object, callback) {
    try {
        createTableStructure(create_table_object, function (err, success) {
            if (err) {
                callback(err);
                return;
            }

            signalling.signalSchemaChange({type: 'schema'});
            addAndRemoveFromQueue(create_table_object, success, callback);

        });
    } catch (e) {
        callback(e);
    }
}

function dropTable(drop_table_object, callback) {
    try {
        deleteTableStructure(drop_table_object, function (err, success) {
            if (err) {
                callback(err);
                return;
            }

            signalling.signalSchemaChange({type: 'schema'});
            addAndRemoveFromQueue(drop_table_object, success, callback);

        });
    } catch (e) {
        callback(e);
    }
}

/*** attribute methods **/

function createAttributeStructure(create_attribute_object, callback) {
    try {
        let validation_error = validation.attribute_object(create_attribute_object);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }

        let record = {
            schema: create_attribute_object.schema,
            table: create_attribute_object.table,
            attribute: create_attribute_object.attribute,
            id: uuidV4(),
            schema_table: create_attribute_object.schema + '.' + create_attribute_object.table
        };

        let insertObject = {
            operation: 'insert',
            schema: 'system',
            table: 'hdb_attribute',
            hash_attribute: 'id',
            records: [record]
        };

        insert.insert(insertObject, function (err, result) {
            winston.info('attribute:' + record.attribute);
            winston.info(result);
            callback(err, result);
        });
    } catch (e) {
        callback(e);
    }
}

function deleteAttributeStructure(attribute_drop_object, callback) {
    let search_obj = {};
    search_obj.schema = 'system';
    search_obj.table = 'hdb_attribute';
    search_obj.hash_attribute = 'id';
    search_obj.get_attributes = ['id', 'attribute'];

    if (attribute_drop_object.table && attribute_drop_object.schema) {
        search_obj.search_attribute = 'schema_table';
        search_obj.search_value = `${attribute_drop_object.schema}.${attribute_drop_object.table}`;
    } else if (attribute_drop_object.schema) {
        search_obj.search_attribute = 'schema';
        search_obj.search_value = `${attribute_drop_object.schema}`;
    } else {
        callback('attribute drop requires table and or schema.');
        return;
    }

    search.searchByValue(search_obj, function (err, attributes) {
        if (err) {
            callback(err);
            return;
        }

        if (attributes && attributes.length > 0) {
            let delete_table_object = {"table": "hdb_attribute", "schema": "system", "hash_values": []};
            for (att in attributes) {
                if ((attribute_drop_object.attribute && attribute_drop_object.attribute === attributes[att].attribute)
                    || !attribute_drop_object.attribute) {

                    delete_table_object.hash_values.push(attributes[att].id);
                }
            }

            delete_.delete(delete_table_object, function (err, success) {
                if (err) {
                    callback(err);
                    return;
                }

                callback(null, `successfully deleted ${delete_table_object.hash_values.length} attributes`);
            });
        } else {
            callback(null, null);
        }
    });
}

function createAttribute(create_attribute_object, callback) {
    try {
        createAttributeStructure(create_attribute_object, function (err, success) {
            if (err) {
                callback(err);
                return;
            }

            signalling.signalSchemaChange({type: 'schema'});
            addAndRemoveFromQueue(create_attribute_object, success, callback);

        });
    } catch (e) {
        callback(e);
    }
}

function dropAttribute(drop_attribute_object, callback) {
    try {
        let validation_error = validation.attribute_object(create_attribute_object);
        if (validation_error) {
            callback(validation_error, null);
            return;
        }
        deleteAttributeStructure(drop_attribute_object, function (err, success) {
            if (err) {
                callback(err);
                return;
            }
            addAndRemoveFromQueue(drop_attribute_object, success, callback);
        });
    } catch (e) {
        callback(e);
    }
}


/**** utility methods **/

function addAndRemoveFromQueue(ops_object, success_message, callback) {
    schema_ops.addToQueue(ops_object, function (err, id) {
        if (err) {
            callback(err);
            return;
        }
        schema_ops.addToQueue(id, function (err) {
            if (err) {
                callback(err);
                return;
            }
            callback(null, success_message);
        });
    });
}
