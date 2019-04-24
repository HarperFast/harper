const fs = require('fs-extra');
const insert = require('./insert.js');
const async = require('async');
const validation = require('../validation/schema_validator.js');
const search = require('./search.js');
const logger = require('../utility/logging/harper_logger');
const uuidV4 = require('uuid/v4');
const delete_ = require('../data_layer/delete');
    //this is to avoid a circular dependency with insert.
    // insert needs the describe all function but so does this module.
    // as such the functions have been broken out into a separate module.
const schema_describe = require('./schemaDescribe');
const env = require('../utility/environment/environmentManager');
const clone = require('clone');
// TODO: Replace this with fs-extra mkdirp and remove module.
const mkdirp = require('mkdirp');
const _ = require('underscore');
const signalling = require('../utility/signalling');
const log = require('../utility/logging/harper_logger');
const util = require('util');
const cb_insert_insert = util.callbackify(insert.insert);
const hdb_util = require('../utility/common_utils');
const terms = require('../utility/hdbTerms');
const common = require('../utility/common_utils');

// Promisified functions
let p_search_search_by_value = util.promisify(search.searchByValue);
let p_delete_delete = util.promisify(delete_.delete);

// This is used by moveFileToTrash to decide where to put the removed file(s) in the trash directory.
const ENTITY_TYPE_ENUM = {
    TABLE: 'table',
    SCHEMA: 'schema',
    ATTRIBUTE: 'attribute'
};

const DATE_SUBSTR_LENGTH = 19;
const TRASH_BASE_PATH = `${env.get('HDB_ROOT')}/trash/`;

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

// TODO - temp promisified functions that help with async module refactor
const p_createSchemaStructure = util.promisify(createSchemaStructure);

async function createSchema(schema_create_object) {
    try {
        let schema_structure = await p_createSchemaStructure(schema_create_object);
        signalling.signalSchemaChange({type: 'schema'});
        return schema_structure;
    } catch(err) {
        throw err;
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

            cb_insert_insert(insertObject, (err) => {
                if (err) {
                    callback(err);
                    return;
                }

                let schema = schema_create_object.schema;

                fs.mkdir(env.get('HDB_ROOT') + '/schema/' + schema, function (err, data) {
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
            return callback(null, success);
        });
    } catch (e) {
        callback(e);
    }
}

function createTableStructure(create_table_object, callback) {
    let validation_obj = clone(create_table_object);

    let validator = validation.create_table_object(validation_obj);
    if (validator) {
        callback(validator);
        return;
    }

    try{
        validation.validateTableResidence(create_table_object.residence);
    } catch(e){
        return callback(e);
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

        if(create_table_object.residence) {
            if(global.clustering_on) {
                table.residence = create_table_object.residence;
                insertTable();
            } else {
                return callback(`Clustering does not appear to be enabled.  Cannot insert table with property 'residence'.`);
            }
        } else {
            insertTable();
        }

        function insertTable(){
            let insertObject = {
                operation: 'insert',
                schema: 'system',
                table: 'hdb_table',
                hash_attribute: 'id',
                records: [table]
            };

            cb_insert_insert(insertObject, (err) => {
                if (err) {
                    callback(err);
                    return;
                }

                fs.mkdir(env.get('HDB_ROOT') + '/schema/' + create_table_object.schema + '/' + create_table_object.table, function (err, data) {
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
                            return;
                        }
                    }

                    callback(null, `table ${create_table_object.schema}.${create_table_object.table} successfully created.`);
                });
            });
        }
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
                deleteSchemaAttributes.bind(null, drop_schema_object) // takes 'drop_schema_object, returns text successfully deleted ${schema}`
            ],
            function(err, data) {
                if( err) {
                    logger.error(`There was a problem deleting ${schema}.  Please check the logs for more info`);
                    logger.error(err);
                    return callback(err);
                } else {
                    callback(null, `successfully deleted schema ${schema}`);
                }
            });
    } catch (e) {
        logger.error(e);
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
                logger.error(`There was a problem deleting ${schema}.  Please check the logs for more info`);
                logger.error(err);
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
            return callback(null, success);
        });
    } catch (e) {
        logger.error(e);
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
            return callback(null, success);
        });
    } catch (e) {
        callback(e);
    }
}

/**
 * Drops (moves to trash) all files for the specified attribute.
 * @param drop_attribute_object - The JSON formatted inbound message.
 * @returns {Promise<*>}
 */
async function dropAttribute(drop_attribute_object) {
    let validation_error = validation.attribute_object(drop_attribute_object);
    if (validation_error) {
        throw new Error(validation_error);
    }
    if(drop_attribute_object.attribute === global.hdb_schema[drop_attribute_object.schema][drop_attribute_object.table].hash_attribute) {
        throw new Error('You cannot drop a hash attribute');
    }
    let success = await moveAttributeToTrash(drop_attribute_object).catch((err) => {
        log.error(`Got an error deleting attribute ${util.inspect(drop_attribute_object)}.`);
        throw err;
    });
    return success;
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
 * @param drop_schema_object - Object describing the table being dropped
 * @param tables - the tables contained by the schema that will also be deleted
 * @param callback - callback function
 * @returns {*}
 */
function moveSchemaToTrash(drop_schema_object, tables, callback) {
    if(!drop_schema_object) { return callback("drop_table_object was not found.");}
    if(!tables) { return callback("tables parameter was null.")}
    let root_path = env.get('HDB_ROOT');
    let path = `${root_path}/schema/${drop_schema_object.schema}`;
    let currDate = new Date().toISOString().substr(0, DATE_SUBSTR_LENGTH);
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
                    for (let t in tables) {
                        delete_table_object.hash_values.push(tables[t].id);
                    }
                }
                if( delete_table_object.hash_values && delete_table_object.hash_values.length > 0 ) {
                    delete_.delete(delete_table_object, function (err) {
                        if (err) {
                            return callback(err);
                        } else {
                            callback();
                        }
                    });
                } else {
                    callback();
                }
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
    let currDate = new Date().toISOString().substr(0, DATE_SUBSTR_LENGTH);
    let destination_name = `${drop_table_object.table}-${currDate}`;
    let trash_path = `${env.get('HDB_ROOT')}/trash`;
    mkdirp(trash_path, function checkTrashDir(err) {
        if (err) {
            return callback(err);
        }
        fs.move(`${env.get('HDB_ROOT')}/schema/${drop_table_object.schema}/${drop_table_object.table}`,
            `${env.get('HDB_ROOT')}/trash/${destination_name}`, function moveToTrash(err) {
                if (err) {
                    return callback(err);
                } else {
                    return callback(null, drop_table_object);
                }
            });
    });
}

/**
 * Remove an attribute from __hdb_attribute.
 * @param drop_attribute_object - the drop attribute json recieved in drop_attribute inbound message.
 * @returns {Promise<string>}
 */
async function dropAttributeFromSystem(drop_attribute_object) {
    // Remove the attribute from hdb_attribute
    let search_obj = {};
    search_obj.schema = 'system';
    search_obj.table = 'hdb_attribute';
    search_obj.hash_attribute = 'id';
    search_obj.search_attribute = 'attribute';
    search_obj.search_value = drop_attribute_object.attribute;
    search_obj.get_attributes = ['id'];

    let attributes = await p_search_search_by_value(search_obj).catch((err) => {
        log.error(err);
    });

    if (!attributes || attributes.length < 1) {
        return `Attribute ${drop_attribute_object.attribute} was not found.`;
    }

    let delete_table_object = {
        table: "hdb_attribute",
        schema: "system",
        hash_attribute: "id",
        hash_values: [attributes[0].id]
    };
    // Remove the specified attribute from hdb_attribute
    let result = await p_delete_delete(delete_table_object).catch((err) => {
        log.error(`Got an error removing attribute ${drop_attribute_object.attribute} from hdb_attribute.`);
        throw err;
    });

    return result;
}

/**
 * Performs the move of the target attribute and it's __hdb_hash entry to the trash directory.
 * @param drop_attribute_object - Descriptor of the table being moved to trash.
 */
async function moveAttributeToTrash (drop_attribute_object) {
    // TODO: Need to do specific rollback actions if any of the actions below fails.  https://harperdb.atlassian.net/browse/HDB-312
    let path = `${env.get('HDB_ROOT')}/schema/${drop_attribute_object.schema}/${drop_attribute_object.table}/${drop_attribute_object.attribute}`;
    let hash_path = `${env.get('HDB_ROOT')}/schema/${drop_attribute_object.schema}/${drop_attribute_object.table}/${terms.HASH_FOLDER_NAME}/${drop_attribute_object.attribute}`;
    let currDate = new Date().toISOString().substr(0, DATE_SUBSTR_LENGTH);
    let attribute_trash_path = `${env.get('HDB_ROOT')}/trash/${ENTITY_TYPE_ENUM.ATTRIBUTE}/${drop_attribute_object.attribute}-${currDate}`;
    let attribute_hash_trash_path = `${attribute_trash_path}/${terms.HASH_FOLDER_NAME}/${drop_attribute_object.attribute}`;

    let att_result = await moveFolderToTrash(path, attribute_trash_path).catch((err) => {
       log.error(`There was a problem moving the attribute at path ${path} to the trash at path: ${attribute_trash_path}`);
       // Not good, rollback attribute folder
       throw err;
    });
    if(!att_result) {
        return false;
    }
    let hash_result = await moveFolderToTrash(hash_path, attribute_hash_trash_path).catch((err) => {
       log.error(`There was a problem moving the hash attribute at path ${path} to the trash at path: ${attribute_trash_path}`);
        // Not good, rollback attribute __hdb_hash folder and attribute folder
        throw err;
    });

    let drop_result = await dropAttributeFromSystem(drop_attribute_object).catch((err) => {
       log.error(`There was a problem dropping attribute: ${drop_attribute_object.attribute} from hdb_attribute.`);
        // Not good, rollback attribute folder, __hdb_hash folder, and attribute removal from hdb_attribute if it happened.
       throw err;
    });

    return drop_result;
}

/**
 * Move the specified folder from path to the trash path folder.  If the trash folder does not exist, it will be created.
 *
 * @param path
 * @param trash_path
 * @returns {Promise<boolean>}
 */
async function moveFolderToTrash(path, trash_path) {
    if(hdb_util.isEmptyOrZeroLength(path) || hdb_util.isEmptyOrZeroLength(trash_path)) {
        return false;
    }

    // if mk_result is returned as null, the folder already exists.
    let mk_result = await fs.mkdirp(TRASH_BASE_PATH).catch((err) => {
        log.info(`Failed to create the trash directory.`);
        throw err;
    });
    let move_result = await fs.move(path, trash_path, {overwrite: true}).catch((err) => {
       log.error(`Got an error moving path ${path} to trash path: ${trash_path}`);
       throw err;
    });
    return true;
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

        let search_obj = {};
        search_obj.schema = 'system';
        search_obj.table = 'hdb_attribute';
        search_obj.hash_attribute = 'id';
        search_obj.get_attributes = ['*'];
        search_obj.search_attribute = 'attribute';
        search_obj.search_value = create_attribute_object.attribute;

        search.searchByValue(search_obj, function(err, attributes){
            if(attributes && attributes.length > 0){
                for(let att in attributes){
                    if(attributes[att].schema === create_attribute_object.schema
                        && attributes[att].table === create_attribute_object.table){
                        return callback(`attribute already exists with id ${ JSON.stringify(attributes[att])}`);
                    }
                }
            }

            let record = {
                schema: create_attribute_object.schema,
                table: create_attribute_object.table,
                attribute: create_attribute_object.attribute,
                id: uuidV4(),
                schema_table: create_attribute_object.schema + '.' + create_attribute_object.table
            };

            if(create_attribute_object.id){
                record.id = create_attribute_object.id;
            }

            let insertObject = {
                operation: 'insert',
                schema: 'system',
                table: 'hdb_attribute',
                hash_attribute: 'id',
                records: [record]
            };
            logger.info("insert object:" + JSON.stringify(insertObject));

            cb_insert_insert(insertObject, (err, res) => {
                logger.info('attribute:' + record.attribute);
                logger.info(res);
                callback(err, res);

            });
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
            for (let att in attributes) {
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
        if(global.clustering_on
            && !create_attribute_object.delegated && create_attribute_object.schema != 'system') {

            createAttributeStructure(create_attribute_object, function (err, success) {
                if (err) {
                    callback(err);
                    return;
                }

                create_attribute_object.delegated = true;
                create_attribute_object.operation = 'create_attribute';
                create_attribute_object.id = success.id;

                let payload = {
                    "type": "clustering_payload", "pid": process.pid,
                    "clustering_type": "broadcast",
                    "id": success.id,
                    "body": create_attribute_object
                };

                try {
                    common.callProcessSend(payload);
                } catch(e) {
                    logger.error(e);
                }

                signalling.signalSchemaChange({type: 'schema'});
                return callback(null, success);

            });

        }else{
            createAttributeStructure(create_attribute_object, function (err, success) {
                if (err) {
                    callback(err);
                    return;
                }

                signalling.signalSchemaChange({type: 'schema'});
                return callback(null, success);
            });
        }
    } catch (e) {
        callback(e);
    }
}
