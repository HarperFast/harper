'use strict';

const validation = require('../validation/schema_validator');
const logger = require('../utility/logging/harper_logger');
const uuidV4 = require('uuid/v4');
const clone = require('clone');
const signalling = require('../utility/signalling');
const hdb_util = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const util = require('util');
const harperBridge = require('./harperBridge/harperBridge');

module.exports = {
    createSchema: createSchema,
    createSchemaStructure: createSchemaStructure,
    createTable: createTable,
    createTableStructure: createTableStructure,
    createAttribute: createAttribute,
    dropSchema: dropSchema,
    dropTable: dropTable,
    dropAttribute: dropAttribute
};

/** EXPORTED FUNCTIONS **/

async function createSchema(schema_create_object) {
    try {
        let schema_structure = await createSchemaStructure(schema_create_object);
        signalling.signalSchemaChange(signalling.SCHEMA_CHANGE_MESSAGE);

        return schema_structure;
    } catch(err) {
        throw err;
    }
}

async function createSchemaStructure(schema_create_object) {
    let validation_error = validation.schema_object(schema_create_object);
    if (validation_error) {
        throw validation_error;
    }

    if (!hdb_util.checkSchemaExists(schema_create_object.schema)) {
        throw `schema ${schema_create_object.schema} already exists`;
    }

    try {
        await harperBridge.createSchema(schema_create_object);

        return `schema ${schema_create_object.schema} successfully created`;
    } catch(err) {
        throw err;
    }
}

async function createTable(create_table_object) {
    try {
        let create_table_structure = await createTableStructure(create_table_object);
        signalling.signalSchemaChange(signalling.SCHEMA_CHANGE_MESSAGE);

        return create_table_structure;
    } catch(err) {
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

    let invalid_schema_msg = hdb_util.checkSchemaExists(create_table_object.schema);
    if (invalid_schema_msg) {
        throw invalid_schema_msg;
    }

    if (!hdb_util.checkTableExists(create_table_object.schema, create_table_object.table)) {
        throw `table ${create_table_object.table} already exists in schema ${create_table_object.schema}`;
    }

    let table_system_data = {
        name: create_table_object.table,
        schema: create_table_object.schema,
        id: uuidV4(),
        hash_attribute: create_table_object.hash_attribute
    };

    try {
        if(create_table_object.residence) {
            if(global.clustering_on) {
                table_system_data.residence = create_table_object.residence;
                await harperBridge.createTable(table_system_data, create_table_object);
            } else {
                throw new Error(`Clustering does not appear to be enabled. Cannot insert table with property 'residence'.`);
            }
        } else {
            await harperBridge.createTable(table_system_data, create_table_object);
        }

        return `table ${create_table_object.schema}.${create_table_object.table} successfully created.`;
    } catch(err) {
        throw err;
    }
}

async function dropSchema(drop_schema_object) {
    let validation_error = validation.schema_object(drop_schema_object);
    if (validation_error) {
        throw validation_error;
    }

    let invalid_schema_msg = hdb_util.checkSchemaExists(drop_schema_object.schema);
    if (invalid_schema_msg) {
        throw invalid_schema_msg;
    }

    try {
        await harperBridge.dropSchema(drop_schema_object);
        signalling.signalSchemaChange(signalling.SCHEMA_CHANGE_MESSAGE);
        delete global.hdb_schema[drop_schema_object.schema];
        const SCHEMA_DELETE_MSG = `successfully deleted schema ${drop_schema_object.schema}`;

        return SCHEMA_DELETE_MSG;
    } catch (err) {
        throw err;
    }
}

async function dropTable(drop_table_object) {
    let validation_error = validation.table_object(drop_table_object);
    if (validation_error) {
        throw validation_error;
    }

    let invalid_schema_table_msg = hdb_util.checkSchemaTableExist(drop_table_object.schema, drop_table_object.table);
    if (invalid_schema_table_msg) {
        throw invalid_schema_table_msg;
    }

    try {
        await harperBridge.dropTable(drop_table_object);
        signalling.signalSchemaChange({type: 'schema'});
        const TABLE_DELETE_MSG = `successfully deleted table ${drop_table_object.schema}.${drop_table_object.table}`;

        return TABLE_DELETE_MSG;
    } catch (err) {
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

    if(hdb_terms.TIME_STAMP_NAMES.indexOf(drop_attribute_object.attribute) >= 0){
        throw new Error(`cannot drop internal timestamp attribute: ${drop_attribute_object.attribute}`);
    }

    try {
        await harperBridge.dropAttribute(drop_attribute_object);
        dropAttributeFromGlobal(drop_attribute_object);

        return `successfully deleted attribute '${drop_attribute_object.attribute}'`;
    } catch(err) {
        logger.error(`Got an error deleting attribute ${util.inspect(drop_attribute_object)}.`);
        throw err;
   }
}

/**
 * Removes the dropped attribute from the global hdb schema object.
 * @param drop_attribute_object
 */
function dropAttributeFromGlobal(drop_attribute_object) {
    let attributes_obj = Object.values(global.hdb_schema[drop_attribute_object.schema][drop_attribute_object.table]['attributes']);

    for (let i = 0; i < attributes_obj.length; i++) {
        if (attributes_obj[i].attribute === drop_attribute_object.attribute) {
            global.hdb_schema[drop_attribute_object.schema][drop_attribute_object.table]['attributes'].splice(i, 1);
        }
    }
}

async function createAttribute(create_attribute_object) {
    if (!global.hdb_schema[create_attribute_object.schema]) {
        throw new Error(`schema ${create_attribute_object.schema} does not exist`);
    }

    if (!global.hdb_schema[create_attribute_object.schema][create_attribute_object.table]) {
        throw new Error(`table ${create_attribute_object.table} does not exists in schema ${create_attribute_object.schema}`);
    }

    let attribute_structure;
    try {
        attribute_structure = await harperBridge.createAttribute(create_attribute_object);
        signalling.signalSchemaChange(signalling.SCHEMA_CHANGE_MESSAGE);

        return attribute_structure;
    } catch(err) {
        logger.error(err);
        throw err;
    }
}
