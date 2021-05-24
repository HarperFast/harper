'use strict';

const validation = require('../validation/schema_validator');
const schema_metadata_validator = require('../validation/schemaMetadataValidator');
const logger = require('../utility/logging/harper_logger');
const uuidV4 = require('uuid/v4');
const clone = require('clone');
const signalling = require('../utility/signalling');
const hdb_terms = require('../utility/hdbTerms');
const util = require('util');
const harperBridge = require('./harperBridge/harperBridge');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;


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
        signalling.signalSchemaChange(schema_create_object);

        return schema_structure;
    } catch(err) {
        throw err;
    }
}

async function createSchemaStructure(schema_create_object) {
    let validation_error = validation.schema_object(schema_create_object);
    if (validation_error) {
        throw handleHDBError(validation_error, validation_error.message, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    if (!await schema_metadata_validator.checkSchemaExists(schema_create_object.schema)) {
        throw handleHDBError(new Error(), HDB_ERROR_MSGS.SCHEMA_EXISTS_ERR(schema_create_object.schema), HTTP_STATUS_CODES.BAD_REQUEST, logger.ERR, HDB_ERROR_MSGS.SCHEMA_EXISTS_ERR(schema_create_object.schema));
    }

    try {
        await harperBridge.createSchema(schema_create_object);

        return `schema '${schema_create_object.schema}' successfully created`;
    } catch(err) {
        throw err;
    }
}

async function createTable(create_table_object) {
    try {
        let create_table_structure = await createTableStructure(create_table_object);
        signalling.signalSchemaChange(create_table_object);

        return create_table_structure;
    } catch(err) {
        throw err;
    }
}

async function createTableStructure(create_table_object) {
    let validation_obj = clone(create_table_object);
    let validation_error = validation.create_table_object(validation_obj);
    if (validation_error) {
        throw handleHDBError(validation_error, validation_error.message, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    validation.validateTableResidence(create_table_object.residence);

    let invalid_schema_msg = await schema_metadata_validator.checkSchemaExists(create_table_object.schema);
    if (invalid_schema_msg) {
        throw handleHDBError(new Error(), invalid_schema_msg, HTTP_STATUS_CODES.NOT_FOUND, logger.ERR, invalid_schema_msg);
    }

    let invalid_table_msg = await schema_metadata_validator.checkSchemaTableExists(create_table_object.schema, create_table_object.table);
    if (!invalid_table_msg) {
        throw handleHDBError(new Error(), HDB_ERROR_MSGS.TABLE_EXISTS_ERR(create_table_object.schema, create_table_object.table), HTTP_STATUS_CODES.BAD_REQUEST, logger.ERR, HDB_ERROR_MSGS.TABLE_EXISTS_ERR(create_table_object.schema, create_table_object.table));
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
                throw handleHDBError(new Error(), `Clustering does not appear to be enabled. Cannot insert table with property 'residence'.`, HTTP_STATUS_CODES.BAD_REQUEST);
            }
        } else {
            await harperBridge.createTable(table_system_data, create_table_object);
        }

        return `table '${create_table_object.schema}.${create_table_object.table}' successfully created.`;
    } catch(err) {
        throw err;
    }
}

async function dropSchema(drop_schema_object) {
    let validation_error = validation.schema_object(drop_schema_object);
    if (validation_error) {
        throw handleHDBError(validation_error, validation_error.message, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    let invalid_schema_msg = await schema_metadata_validator.checkSchemaExists(drop_schema_object.schema);
    if (invalid_schema_msg) {
        throw handleHDBError(new Error(), invalid_schema_msg, HTTP_STATUS_CODES.NOT_FOUND, logger.ERR, invalid_schema_msg);
    }

    //we refresh and assign the entire schema metadata to global in order to make sure we have the latest
    let schema = await schema_metadata_validator.schema_describe.describeSchema({schema: drop_schema_object.schema});
    global.hdb_schema[drop_schema_object.schema] = schema;

    try {
        await harperBridge.dropSchema(drop_schema_object);
        signalling.signalSchemaChange(drop_schema_object);
        delete global.hdb_schema[drop_schema_object.schema];
        const SCHEMA_DELETE_MSG = `successfully deleted schema '${drop_schema_object.schema}'`;

        return SCHEMA_DELETE_MSG;
    } catch (err) {
        throw err;
    }
}

async function dropTable(drop_table_object) {
    let validation_error = validation.table_object(drop_table_object);
    if (validation_error) {
        throw handleHDBError(validation_error, validation_error.message, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    let invalid_schema_table_msg = await schema_metadata_validator.checkSchemaTableExists(drop_table_object.schema, drop_table_object.table);
    if (invalid_schema_table_msg) {
        throw handleHDBError(new Error(), invalid_schema_table_msg, HTTP_STATUS_CODES.NOT_FOUND, logger.ERR, invalid_schema_table_msg);
    }

    //we refresh and assign the entire table metadata to global in order to make sure we have the latest
    let table = await schema_metadata_validator.schema_describe.describeTable({schema: drop_table_object.schema, table: drop_table_object.table});
    global.hdb_schema[drop_table_object.schema][drop_table_object.table] = table;

    try {
        await harperBridge.dropTable(drop_table_object);
        signalling.signalSchemaChange(drop_table_object);
        const TABLE_DELETE_MSG = `successfully deleted table '${drop_table_object.schema}.${drop_table_object.table}'`;

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
        throw handleHDBError(validation_error, validation_error.message, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    let invalid_schema_table_msg = await schema_metadata_validator.checkSchemaTableExists(drop_attribute_object.schema, drop_attribute_object.table);
    if (invalid_schema_table_msg) {
        throw handleHDBError(new Error(), invalid_schema_table_msg, HTTP_STATUS_CODES.NOT_FOUND, logger.ERR, invalid_schema_table_msg);
    }

    if (drop_attribute_object.attribute === global.hdb_schema[drop_attribute_object.schema][drop_attribute_object.table].hash_attribute) {
        throw handleHDBError(new Error(), 'You cannot drop a hash attribute', HTTP_STATUS_CODES.BAD_REQUEST);
    }

    if(hdb_terms.TIME_STAMP_NAMES.indexOf(drop_attribute_object.attribute) >= 0){
        throw handleHDBError(new Error(), `cannot drop internal timestamp attribute: ${drop_attribute_object.attribute}`, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    try {
        await harperBridge.dropAttribute(drop_attribute_object);
        dropAttributeFromGlobal(drop_attribute_object);
        signalling.signalSchemaChange(drop_attribute_object);

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
        throw handleHDBError(new Error(), HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(create_attribute_object.schema), HTTP_STATUS_CODES.NOT_FOUND);
    }

    if (!global.hdb_schema[create_attribute_object.schema][create_attribute_object.table]) {
        throw handleHDBError(new Error(), HDB_ERROR_MSGS.TABLE_NOT_FOUND(create_attribute_object.schema, create_attribute_object.table), HTTP_STATUS_CODES.NOT_FOUND);
    }

    try {
        await harperBridge.createAttribute(create_attribute_object);
        signalling.signalSchemaChange(create_attribute_object);

        return `attribute '${create_attribute_object.schema}.${create_attribute_object.table}.${create_attribute_object.attribute}' successfully created.`;
    } catch(err) {
        logger.error(err);
        throw err;
    }
}
