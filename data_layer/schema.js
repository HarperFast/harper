'use strict';

const fs = require('fs-extra');
const insert = require('./insert.js');
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
const signalling = require('../utility/signalling');
const util = require('util');
const hdb_util = require('../utility/common_utils');
const terms = require('../utility/hdbTerms');

// Promisified functions
let p_search_search_by_value = util.promisify(search.searchByValue);
let p_delete_delete = util.promisify(delete_.delete);
let p_search_by_conditions = util.promisify(search.searchByConditions);

// This is used by moveFileToTrash to decide where to put the removed file(s) in the trash directory.
const ENTITY_TYPE_ENUM = {
    TABLE: 'table',
    SCHEMA: 'schema',
    ATTRIBUTE: 'attribute'
};
const DATE_SUBSTR_LENGTH = 19;
const TRASH_BASE_PATH = `${env.get('HDB_ROOT')}/trash/`;

let current_date = new Date().toISOString().substr(0, DATE_SUBSTR_LENGTH);

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

async function createSchema(schema_create_object) {
    try {
        let schema_structure = await createSchemaStructure(schema_create_object);
        let create_schema_msg = hdb_util.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
        create_schema_msg.transaction = schema_create_object;
        hdb_util.sendTransactionToSocketCluster(terms.INTERNAL_SC_CHANNELS.CREATE_SCHEMA, create_schema_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
        signalling.signalSchemaChange(signalling.SCHEMA_CHANGE_MESSAGE);

        return schema_structure;
    } catch(err) {
        logger.error(err);
        throw err;
    }
}

async function createSchemaStructure(schema_create_object) {
    let validation_error = validation.schema_object(schema_create_object);
    if (validation_error) {
        throw validation_error;
    }

    try {
        let schema_search = await searchForSchema(schema_create_object.schema);

        if (schema_search && schema_search.length > 0) {
            throw new Error(`Schema ${schema_create_object.schema} already exists`);
        }

        let insert_object = {
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

        await insert.insert(insert_object);
        let schema_object = schema_create_object.schema;
        await fs.mkdir(env.get('HDB_ROOT') + '/schema/' + schema_object, {mode: terms.HDB_FILE_PERMISSIONS});

        return `schema ${schema_create_object.schema} successfully created`;
    } catch(err) {
        if (err.errno === -17) {
            throw new Error('schema already exists');
        }
        throw err;
    }
}

async function createTable(create_table_object) {
    try {
        let create_table_structure = await createTableStructure(create_table_object);
        let create_table_msg = hdb_util.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
        create_table_msg.transaction = create_table_object;
        hdb_util.sendTransactionToSocketCluster(terms.INTERNAL_SC_CHANNELS.CREATE_TABLE, create_table_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
        signalling.signalSchemaChange(signalling.SCHEMA_CHANGE_MESSAGE);

        return create_table_structure;
    } catch(err) {
        logger.error(err);
        throw err;
    }
}

async function createTableStructure(create_table_object) {
    let validation_obj = clone(create_table_object);
    let validation_error = validation.create_table_object(validation_obj);
    if (validation_error) {
        throw validation_error;
    }

    validation.validateTableResidence(create_table_object.residence);

    try {
        let schema_search = await searchForSchema(create_table_object.schema);
        if (!schema_search || schema_search.length === 0) {
            throw new Error(`schema ${create_table_object.schema} does not exist`);
        }

        let table_search = await searchForTable(create_table_object.schema, create_table_object.table);
        if (table_search && table_search.length > 0) {
            throw new Error(`table ${create_table_object.table} already exists in schema ${create_table_object.schema}`);
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
                await insertTable(table, create_table_object);
            } else {
                throw new Error(`Clustering does not appear to be enabled. Cannot insert table with property 'residence'.`);
            }
        } else {
            await insertTable(table, create_table_object);
        }

        return `table ${create_table_object.schema}.${create_table_object.table} successfully created.`;
    } catch(err) {
        throw err;
    }
}

async function insertTable(table, create_table_object) {
    let insertObject = {
        operation: 'insert',
        schema: 'system',
        table: 'hdb_table',
        hash_attribute: 'id',
        records: [table]
    };

    try {
        await insert.insert(insertObject);
        await fs.mkdir(env.get('HDB_ROOT') + '/schema/' + create_table_object.schema + '/' + create_table_object.table, {mode: terms.HDB_FILE_PERMISSIONS});
    } catch(err) {
        if (err.errno === -2) {
            throw new Error('schema does not exist');
        }
        if (err.errno === -17) {
            throw new Error('table already exists');
        }
        throw err;
    }
}

async function dropSchema(drop_schema_object) {
    try {
        let move_schema_struc_trash = await moveSchemaStructureToTrash(drop_schema_object);
        signalling.signalSchemaChange(signalling.SCHEMA_CHANGE_MESSAGE);
        delete global.hdb_schema[drop_schema_object.schema];

        return move_schema_struc_trash;
    } catch(err) {
        logger.error(err);
        throw err;
    }
}

/**
 * Moves a schema and it's contained tables/attributes to the trash directory.
 * @param drop_schema_object
 * @returns {Promise<string>}
 */
async function moveSchemaStructureToTrash(drop_schema_object) {
    let validation_error = validation.schema_object(drop_schema_object);
    if (validation_error) {
        throw validation_error;
    }

    let schema = drop_schema_object.schema;
    let delete_schema_object = {
        table: "hdb_schema",
        schema: "system",
        hash_values: [schema]
    };

    let search_object = {
        schema: 'system',
        table: 'hdb_table',
        hash_attribute: 'id',
        search_attribute: 'schema',
        search_value: schema,
        get_attributes: ['id']
    };

    try {
        await p_delete_delete(delete_schema_object);
        let search_value = await p_search_search_by_value(search_object);
        await moveSchemaToTrash(drop_schema_object, search_value);
        await deleteAttributeStructure(drop_schema_object);

        return `successfully deleted schema ${schema}`;
    } catch(err) {
        throw err;
    }
}

async function dropTable(drop_table_object) {
    try {
        let move_table_struc_trash = await moveTableStructureToTrash(drop_table_object);
        signalling.signalSchemaChange(signalling.SCHEMA_CHANGE_MESSAGE);

        return move_table_struc_trash;
    } catch(err) {
        logger.error(err);
        throw err;
    }
}

/**
 * Moves a target table and it's attributes to the trash directory.
 * @param drop_table_object - Descriptor for the table being targeted for move.
 * @returns {Promise<string>}
 */
async function moveTableStructureToTrash(drop_table_object) {
    let validation_error = validation.table_object(drop_table_object);
    if (validation_error) {
        throw validation_error;
    }

    let schema = drop_table_object.schema;
    let table = drop_table_object.table;

    let search_object = {
        schema: 'system',
        table: 'hdb_table',
        hash_attribute: 'id',
        search_attribute: 'name',
        search_value: table,
        get_attributes: ['name', 'schema', 'id']
    };

    try {
        let search_value = await p_search_search_by_value(search_object);
        let delete_table_object = await buildDropTableObject(drop_table_object, search_value);
        await p_delete_delete(delete_table_object);
        await moveTableToTrash(drop_table_object);
        await deleteAttributeStructure(drop_table_object);

        return `successfully deleted table ${schema}.${table}`;
    } catch(err) {
        throw err;
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
        throw validation_error;
    }

    if(drop_attribute_object.attribute === global.hdb_schema[drop_attribute_object.schema][drop_attribute_object.table].hash_attribute) {
        throw new Error('You cannot drop a hash attribute');
    }

    try {
        let success = await moveAttributeToTrash(drop_attribute_object);

        return success;
    } catch(err) {
        logger.error(`Got an error deleting attribute ${util.inspect(drop_attribute_object)}.`);
        throw err;
   }
}

/** HELPER FUNCTIONS **/

/**
 * Moves the schema and it's contained tables to the trash folder.  Note the trash folder is not
 * automatically emptied.
 *
 * @param drop_schema_object - Object describing the table being dropped
 * @param tables - the tables contained by the schema that will also be deleted
 * @returns {Promise<void>}
 */
async function moveSchemaToTrash(drop_schema_object, tables) {
    if (!tables) {
        throw new Error('tables parameter was null.');
    }

    let root_path = env.get('HDB_ROOT');
    let origin_path = `${root_path}/schema/${drop_schema_object.schema}`;
    let destination_name = `${drop_schema_object.schema}-${current_date}`;
    let trash_path = `${TRASH_BASE_PATH}${destination_name}`;

    try {
        await moveFolderToTrash(origin_path, trash_path);

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
            await p_delete_delete(delete_table_object);
        }
    } catch(err) {
        throw err;
    }
}

/**
 * Builds a descriptor object that describes the table targeted for the trash.
 * @param drop_table_object - Top level descriptor of the table being moved.
 * @param data - The data found by the search function.
 * @returns {Promise<{schema: string, hash_attribute: string, hash_values: *[], table: string}>}
 */
function buildDropTableObject(drop_table_object, data) {
    let delete_table;

    // Data found by the search function should match the drop_table_object
    for (let item in data) {
        if (data[item].name === drop_table_object.table && data[item].schema === drop_table_object.schema) {
            delete_table = data[item];
        }
    }

    if (!delete_table) {
        throw new Error(`${drop_table_object.schema}.${drop_table_object.table} was not found`);
    }

    let delete_table_object = {
        table: "hdb_table",
        schema: "system",
        hash_attribute: "id",
        hash_values: [delete_table.id]
    };

    return delete_table_object;
}

/**
 * Performs the move of the target table to the trash directory.
 * @param drop_table_object - Descriptor of the table being moved to trash.
 * @returns {Promise<void>}
 */
async function moveTableToTrash(drop_table_object) {
    let root_path = env.get('HDB_ROOT');
    let origin_path = `${root_path}/schema/${drop_table_object.schema}/${drop_table_object.table}`;
    let destination_name = `${drop_table_object.schema}-${drop_table_object.table}-${current_date}`;
    let trash_path = `${TRASH_BASE_PATH}${destination_name}`;

    try {
        await moveFolderToTrash(origin_path, trash_path);
    } catch(err) {
        throw err;
    }
}

/**
 * Remove an attribute from __hdb_attribute.
 * @param drop_attribute_object - the drop attribute json received in drop_attribute inbound message.
 * @returns {Promise<string>}
 */
async function dropAttributeFromSystem(drop_attribute_object) {
    let search_object = {
        schema: 'system',
        table: 'hdb_attribute',
        hash_attribute: 'id',
        search_attribute: 'attribute',
        search_value: drop_attribute_object.attribute,
        get_attributes: ['id']
    };

    try {
        let attributes = await p_search_search_by_value(search_object);
        if (!attributes || attributes.length < 1) {
            throw new Error(`Attribute ${drop_attribute_object.attribute} was not found.`);
        }

        let delete_table_object = {
            table: "hdb_attribute",
            schema: "system",
            hash_attribute: "id",
            hash_values: [attributes[0].id]
        };

        let success_message = await p_delete_delete(delete_table_object);

        return success_message;
    } catch(err) {
        throw err;
    }
}

/**
 * Performs the move of the target attribute and it's __hdb_hash entry to the trash directory.
 * @param drop_attribute_object - Descriptor of the table being moved to trash.
 */
async function moveAttributeToTrash(drop_attribute_object) {
    // TODO: Need to do specific rollback actions if any of the actions below fails.  https://harperdb.atlassian.net/browse/HDB-312
    let origin_path = `${env.get('HDB_ROOT')}/schema/${drop_attribute_object.schema}/${drop_attribute_object.table}/${drop_attribute_object.attribute}`;
    let hash_path = `${env.get('HDB_ROOT')}/schema/${drop_attribute_object.schema}/${drop_attribute_object.table}/${terms.HASH_FOLDER_NAME}/${drop_attribute_object.attribute}`;
    let attribute_trash_path = `${env.get('HDB_ROOT')}/trash/${ENTITY_TYPE_ENUM.ATTRIBUTE}/${drop_attribute_object.attribute}-${current_date}`;
    let attribute_hash_trash_path = `${attribute_trash_path}/${terms.HASH_FOLDER_NAME}/${drop_attribute_object.attribute}`;

    try {
        let att_result = await moveFolderToTrash(origin_path, attribute_trash_path);
        if(!att_result) {

            return false;
        }
    } catch(err) {
        // Not good, rollback attribute folder
        logger.error(`There was a problem moving the attribute at path ${origin_path} to the trash at path: ${attribute_trash_path}`);
        throw err;
    }

    try {
       await moveFolderToTrash(hash_path, attribute_hash_trash_path);
    } catch(err) {
        // Not good, rollback attribute __hdb_hash folder and attribute folder
        logger.error(`There was a problem moving the hash attribute at path ${origin_path} to the trash at path: ${attribute_trash_path}`);
        throw err;
    }

    try {
        let drop_result = await dropAttributeFromSystem(drop_attribute_object);

        return drop_result;
    } catch(err) {
        // Not good, rollback attribute folder, __hdb_hash folder, and attribute removal from hdb_attribute if it happened.
        logger.error(`There was a problem dropping attribute: ${drop_attribute_object.attribute} from hdb_attribute.`);
        throw err;
    }
}

/**
 * Move the specified folder from path to the trash path folder.  If the trash folder does not exist, it will be created.
 *
 * @param path
 * @param trash_path
 * @returns {Promise<boolean>}
 */
async function moveFolderToTrash(origin_path, trash_path) {
    if(hdb_util.isEmptyOrZeroLength(origin_path) || hdb_util.isEmptyOrZeroLength(trash_path)) {
        return false;
    }

    try {
        await fs.mkdirp(trash_path, {mode: terms.HDB_FILE_PERMISSIONS});
    } catch(err) {
        logger.error(`Failed to create the trash directory.`);
        throw err;
    }

    try {
        await fs.move(origin_path,trash_path, {overwrite: true});
    } catch(err) {
        logger.error(`Got an error moving path ${origin_path} to trash path: ${trash_path}`);
        throw err;
    }
    return true;
}

async function searchForSchema(schema_name) {
    let search_obj = {
        schema: 'system',
        table: 'hdb_schema',
        get_attributes: ['name'],
        conditions: [{
            'and': {'=': ['name', schema_name]}
        }]
    };

    try {
        let search_result = await p_search_by_conditions(search_obj);

        return search_result;
    } catch(err) {
        throw err;
    }
}

async function searchForTable(schema_name, table_name) {
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

    try {
        let search_result = await p_search_by_conditions(search_obj);

        return search_result;
    } catch(err) {
        throw err;
    }
}

async function createAttributeStructure(create_attribute_object) {
    let validation_error = validation.attribute_object(create_attribute_object);
    if (validation_error) {
        throw validation_error;
    }

    let search_object = {
        schema: 'system',
        table: 'hdb_attribute',
        hash_attribute: 'id',
        get_attributes: ['*'],
        search_attribute: 'attribute',
        search_value: create_attribute_object.attribute
    };

    try {
        let attributes = await p_search_search_by_value(search_object);

        if(attributes && attributes.length > 0) {
            for (let att in attributes) {
                if (attributes[att].schema === create_attribute_object.schema
                    && attributes[att].table === create_attribute_object.table) {
                    throw new Error(`attribute already exists with id ${JSON.stringify(attributes[att])}`);
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

        let insert_object = {
            operation: 'insert',
            schema: 'system',
            table: 'hdb_attribute',
            hash_attribute: 'id',
            records: [record]
        };

        logger.info('insert object: ' + JSON.stringify(insert_object));
        let insert_response = await insert.insert(insert_object);
        logger.info('attribute: ' + record.attribute);
        logger.info(insert_response);

        return insert_response;
    } catch(err) {
        throw err;
    }
}

async function deleteAttributeStructure(attribute_drop_object) {
    let search_object = {
        schema:'system',
        table: 'hdb_attribute',
        hash_attribute: 'id',
        get_attributes: ['id', 'attribute']
    };

    if (attribute_drop_object.table && attribute_drop_object.schema) {
        search_object.search_attribute = 'schema_table';
        search_object.search_value = `${attribute_drop_object.schema}.${attribute_drop_object.table}`;
    } else if (attribute_drop_object.schema) {
        search_object.search_attribute = 'schema';
        search_object.search_value = `${attribute_drop_object.schema}`;
    } else {
        throw new Error('attribute drop requires table and or schema.');
    }

    try {
        let attributes = await p_search_search_by_value(search_object);

        if (attributes && attributes.length > 0) {
            let delete_table_object = {
                table: 'hdb_attribute',
                schema: 'system',
                hash_values: []
            };

            for (let att in attributes) {
                if ((attribute_drop_object.attribute && attribute_drop_object.attribute === attributes[att].attribute)
                    || !attribute_drop_object.attribute) {
                    delete_table_object.hash_values.push(attributes[att].id);
                }
            }
            await p_delete_delete(delete_table_object);

            return `successfully deleted ${delete_table_object.hash_values.length} attributes`;
        }
    } catch(err) {
        throw err;
    }
}

async function createAttribute(create_attribute_object) {
    let attribute_structure;
    try {
        if(global.clustering_on
            && !create_attribute_object.delegated && create_attribute_object.schema !== 'system') {

            attribute_structure = await createAttributeStructure(create_attribute_object);
            create_attribute_object.delegated = true;
            create_attribute_object.operation = 'create_attribute';
            create_attribute_object.id = attribute_structure.id;

            let payload = {
                "type": "clustering_payload",
                "pid": process.pid,
                "clustering_type": "broadcast",
                "id": attribute_structure.id,
                "body": create_attribute_object
            };

            hdb_util.callProcessSend(payload);
            signalling.signalSchemaChange(signalling.SCHEMA_CHANGE_MESSAGE);

            return attribute_structure;
        }
        attribute_structure = await createAttributeStructure(create_attribute_object);
        let create_att_msg = hdb_util.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
        create_att_msg.transaction = create_attribute_object;
        hdb_util.sendTransactionToSocketCluster(terms.INTERNAL_SC_CHANNELS.CREATE_ATTRIBUTE, create_att_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
        signalling.signalSchemaChange(signalling.SCHEMA_CHANGE_MESSAGE);

        return attribute_structure;
    } catch(err) {
        logger.error(err);
        throw err;
    }
}
