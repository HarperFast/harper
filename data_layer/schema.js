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
    createTable: createTable,
    createTableStructure: createTableStructure,
    createAttribute: createAttribute,
    createAttributeStructure: createAttributeStructure,
    deleteSchemaStructure: moveSchemaStructureToTrash,
    deleteTableStructure: moveTableStructureToTrash,
    describeTable: schema_describe.describeTable,
    describeSchema: schema_describe.describeSchema,
    describeAll: schema_describe.describeAll,
    dropSchema: dropSchema,
    dropTable: dropTable,
    dropAttribute: dropAttribute
};

/** EXPORTED FUNCTIONS **/

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

/**
 * Moves a schema and it's contained tables/attributes to the trash directory.
 * @param drop_schema_object - Object describing the schema targeted for 'deletion'.
 * @param callback - callback object
 * @returns {*}
 */
function moveSchemaStructureToTrash(drop_schema_object, callback) {
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

        async.waterfall([
                delete_.delete.bind(null, delete_schema_object),    // returns text 'records successfully deleted'
                buildDropSchemaSearchObject.bind(null, schema),     // returns search_obj
                search.searchByValue,                               // returns 'data'
                moveSchemaToTrash.bind(null, drop_schema_object),   // takes 'data' as tables, returns 'delete_table_object'
                deleteSchemaAttributes                              // takes 'drop_schema_object, returns text successfully deleted ${schema}`
            ],
            function(err, data) {
                if( err) {
                    console.error(`There was a problem deleting ${schema}.  Please check the logs for more info`);
                    winston.error(err);
                    return callback(err);
                } else {
                    callback(null, `successfully deleted schema ${schema}`);
                }
            });
    } catch (e) {
        winston.error(e);
        return callback(e);
    }
}

/**
 * Moves a target table and it's attributes to the trash directory.
 * @param drop_table_object - Descriptor for the table being targeted for move.
 * @param callback - callback function.
 */
function moveTableStructureToTrash(drop_table_object, callback) {
    let validation_error = validation.table_object(drop_table_object);
    if (validation_error) {
        callback(validation_error, null);
        return;
    }
    try {
        let schema = drop_table_object.schema;
        let table = drop_table_object.table;
        let search_obj = {};
        search_obj.schema = 'system';
        search_obj.table = 'hdb_table';
        search_obj.hash_attribute = 'id';
        search_obj.search_attribute = 'name';
        search_obj.search_value = drop_table_object.table;
        search_obj.get_attributes = ['name', 'schema', 'id'];
        async.waterfall([
            search.searchByValue.bind(null, search_obj),
            buildDropTableObject.bind(null, drop_table_object),
            delete_.delete,
            moveTableToTrash.bind(null, drop_table_object),
            deleteTableAttributes.bind(null, drop_table_object)
        ], function(err, result) {
            if( err) {
                console.error(`There was a problem deleting ${schema}.  Please check the logs for more info`);
                winston.error(err);
                return callback(err);
            } else {
                callback(null, result);
            }
        });
    } catch (e) {
        callback(e);
    }
}

function dropSchema(drop_schema_object, callback) {
    try {
        moveSchemaStructureToTrash(drop_schema_object, function (err, success) {
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

function dropTable(drop_table_object, callback) {
    try {
        moveTableStructureToTrash(drop_table_object, function (err, success) {
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


/** HELPER FUNCTIONS **/

/**
 * Builds the object used by search to find records for deletion.
 * @param schema - The schema targeted for deletion
 * @param msg - The return message from delete.delete
 * @param callback - callback function
 */
function buildDropSchemaSearchObject(schema, msg, callback) {
    let search_obj = {
        schema: 'system',
        table: 'hdb_table',
        hash_attribute: 'id',
        search_attribute: 'schema',
        search_value: schema,
        get_attributes: ['id']
    };
    callback(null, search_obj);
}

/**
 * Moves the schema and it's contained tables to the trash folder.  Note the trash folder is not
 * automatically emptied.
 *
 * @param drop_table_object - Object describing the table being dropped
 * @param tables - the tables contained by the schema that will also be deleted
 * @param callback - callback function
 * @returns {*}
 */
function moveSchemaToTrash(drop_schema_object, tables, callback) {
    if(!drop_schema_object) { return callback("drop_table_object was not found.");}
    if(!tables) { return callback("tables parameter was null.")}
    let root_path = hdb_properties.get('HDB_ROOT');
    let path = `${root_path}/schema/${drop_schema_object.schema}`;
    let currDate = new Date().toISOString().substr(0, 19);
    let destination_name = `${drop_schema_object.schema}-${currDate}`;
    let trash_path = `${root_path}/trash`;

    //mkdirp will no-op if the 'trash' dir already exists.
    mkdirp(trash_path, function checkTrashDir(err) {
        if (err) {
            return callback(err);
        }
        fs.move(`${path}`,
            `${root_path}/trash/${destination_name}`, function buildDeleteObject(err) {
                if (err) {
                    return callback(err);
                }
                let delete_table_object = {
                    table: "hdb_table",
                    schema: "system",
                    hash_values: []
                };
                if (tables && tables.length > 0) {
                    for (t in tables) {
                        delete_table_object.hash_values.push(tables[t].id);
                    }
                }
                if( delete_table_object.hash_values && delete_table_object.hash_values.length > 0 ) {
                    delete_.delete(delete_table_object, function (err, data) {
                        if (err) {
                            return callback(err);
                        }
                        callback(null, delete_table_object);
                    });
                }
                callback(null, delete_table_object);
            });
    });
}

/**
 * Deletes the attributes contained by the schema.
 * @param drop_schema_object - The object used to described the schema being deleted.
 * @param callback - callback function.
 */
function deleteSchemaAttributes(drop_schema_object, callback) {
    deleteAttributeStructure(drop_schema_object, function deleteSuccess(err, data) {
        if (err) { return callback(err); }
        return callback(null, `successfully deleted schema attributes ${data}`);
    });
}

/**
 * Builds a descriptor object that describes the table targeted for the trash.
 * @param drop_table_object - Top level descriptor of the table being moved.
 * @param data - The data found by the search function.
 * @param callback - Callback function.
 * @returns {*}
 */
function buildDropTableObject (drop_table_object, data, callback) {
    let delete_tb = null;
    // Data found by the search function should match the drop_table_object
    for (let item in data) {
        if (data[item].name === drop_table_object.table && data[item].schema === drop_table_object.schema) {
            delete_tb = data[item];
        }
    }

    if(!delete_tb) {
        return callback(`${drop_table_object.schema}.${drop_table_object.table} was not found`);
    }
    let delete_table_object = {
        table: "hdb_table",
        schema: "system",
        hash_attribute: "id",
        hash_values: [delete_tb.id]
    };
    callback(null, delete_table_object);
}

/**
 * Performs the move of the target table to the trash directory.
 * @param drop_table_object - Descriptor of the table being moved to trash.
 * @param msg - Message returned from the delete.delete function.
 * @param callback - Callback function.
 */
function moveTableToTrash (drop_table_object, msg, callback) {
    let path = `hdb_properties.get('HDB_ROOT')/schema/${drop_table_object.schema}/${drop_table_object.table}`;
    let currDate = new Date().toISOString().substr(0, 19);
    let destination_name = `${drop_table_object.table}-${currDate}`;
    let trash_path = `${hdb_properties.get('HDB_ROOT')}/trash`;
    mkdirp(trash_path, function checkTrashDir(err) {
        if (err) {
            return callback(err);
        }
        fs.move(`${hdb_properties.get('HDB_ROOT')}/schema/${drop_table_object.schema}/${drop_table_object.table}`,
            `${hdb_properties.get('HDB_ROOT')}/trash/${destination_name}`, function moveToTrash(err) {
                if (err) {
                    return callback(err);
                } else {
                    callback(null, drop_table_object);
                }
            });
    });
}

/**
 * Delete the attributes of the table described in the drop_table_object parameter.
 * @param err - Error returned from the moveTableToTrash function.
 * @param drop_table_object - Descriptor of the table being moved.
 * @param callback - Callback function.
 */
function deleteTableAttributes(err, drop_table_object, callback) {
    deleteAttributeStructure(drop_table_object, function completedDrop(err, success) {
        if (err) {
            return callback(err);
        }
        callback(null, `successfully deleted table ${drop_table_object.schema}.${drop_table_object.table}`);
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
