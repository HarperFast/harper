'use strict';

const log = require('../../../../utility/logging/harper_logger');
const schema_validator = require('../../../../validation/schema_validator');
const hdb_terms = require('../../../../utility/hdbTerms');
const insertUpdateValidate = require('../../bridgeUtility/insertUpdateValidate');
const returnObject = require('../../bridgeUtility/insertUpdateReturnObj');
const convertOperationToTransaction = require('../../bridgeUtility/convertOperationToTransaction');
const processData = require('../fsUtility/processData');
const processRows = require('../fsUtility/processRows');
const uuidV4 = require('uuid/v4');

const INSERT_ACTION = 'inserted';

module.exports = createAttribute;

/**
 * Orchestrates the creation of an attribute on the file system and system schema
 * @param create_attribute_object
 * @returns {Promise<{skipped_hashes: *, update_hashes: *, message: string}>}
 */
async function createAttribute(create_attribute_object) {
    let validation_error = schema_validator.attribute_object(create_attribute_object);
    if (validation_error) {
        throw validation_error;
    }

    let attributes_obj_array = [];
    // On initial creation of a table the attribute will not exist in hdb_schema yet
    if(global.hdb_schema[create_attribute_object.schema] && global.hdb_schema[create_attribute_object.schema][create_attribute_object.table]) {
        attributes_obj_array = global.hdb_schema[create_attribute_object.schema][create_attribute_object.table]['attributes'];
    }

    if(Array.isArray(attributes_obj_array) && attributes_obj_array.length > 0) {
        for (let attribute of attributes_obj_array) {
            if (attribute.attribute === create_attribute_object.attribute) {
                throw new Error(`attribute '${attribute.attribute}' already exists in ${create_attribute_object.schema}.${create_attribute_object.table}`);
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
        operation: hdb_terms.OPERATIONS_ENUM.INSERT,
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        table: hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
        hash_attribute: hdb_terms.SYSTEM_TABLE_HASH_ATTRIBUTES.ATTRIBUTE_TABLE_HASH_ATTRIBUTE,
        records: [record]
    };

    try {
        log.info('insert object: ' + JSON.stringify(insert_object));
        let insert_response = await insertData(insert_object);
        log.info('attribute: ' + record.attribute);
        log.info(insert_response);

        return insert_response;
    } catch(err) {
        throw err;
    }
}

/** NOTE **
 * Due to circular dependencies with insertData in insert.js we have a duplicate version
 * of insertData in this file. It should only be used by createAttribute.
 * **/

/**
 * Inserts data specified in the insert_object parameter.
 * @param insert_object
 * @returns {Promise<{skipped_hashes: *, update_hashes: *, message: string}>}
 */
async function insertData(insert_object){
    try {
        let { schema_table, attributes } = insertUpdateValidate(insert_object);
        let { written_hashes, skipped_hashes, ...data_wrapper } = await processRows(insert_object, attributes, schema_table, null);
        await processData(data_wrapper);
        //convertOperationToTransaction(insert_object, written_hashes, schema_table.hash_attribute);

        return returnObject(INSERT_ACTION, written_hashes, insert_object, skipped_hashes);
    } catch(err){
        throw (err);
    }
}
