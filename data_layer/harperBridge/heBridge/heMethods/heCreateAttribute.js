'use strict';

const heProcessInsertUpdateResponse = require('../heUtility/heProcessInsertUpdateResponse');
const heProcessRows = require('../heUtility/heProcessRows');
const heGenerateDataStoreName = require('../heUtility/heGenerateDataStoreName');
const insertUpdateValidate = require('../../bridgeUtility/insertUpdateValidate');
const convertOperationToTransaction = require('../../bridgeUtility/convertOperationToTransaction');
const returnObject = require('../../bridgeUtility/insertUpdateReturnObj');
const helium_utils = require('../../../../utility/helium/heliumUtils');
const schema_validator = require('../../../../validation/schema_validator');
const hdb_terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');
const uuidV4 = require('uuid/v4');
let hdb_helium = helium_utils.initializeHelium();

const ACTION = 'inserted';

module.exports = heCreateAttribute;

function heCreateAttribute(create_attribute_obj) {
    let validation_error = schema_validator.attribute_object(create_attribute_obj);
    if (validation_error) {
        throw validation_error;
    }

    let attributes_obj_array = global.hdb_schema[create_attribute_obj.schema][create_attribute_obj.table]['attributes'];
    for (let attribute of attributes_obj_array) {
        if (attribute.attribute === create_attribute_obj.attribute) {
            throw new Error(`attribute '${attribute.attribute}' already exists in ${create_attribute_obj.schema}.${create_attribute_obj.table}`);
        }
    }

    let record = {
        schema: create_attribute_obj.schema,
        table: create_attribute_obj.table,
        attribute: create_attribute_obj.attribute,
        id: uuidV4(),
        schema_table: create_attribute_obj.schema + '.' + create_attribute_obj.table
    };

    if(create_attribute_obj.id){
        record.id = create_attribute_obj.id;
    }

    let insert_object = {
        operation: hdb_terms.OPERATIONS_ENUM.INSERT,
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        table: hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
        hash_attribute: hdb_terms.SYSTEM_TABLE_HASH,
        records: [record]
    };
    let datastore_name = heGenerateDataStoreName(create_attribute_obj.schema, create_attribute_obj.table, create_attribute_obj.attribute);

    try {
        let create_datastore_result = hdb_helium.createDataStores([datastore_name]);
        if (create_datastore_result[0][1] !== hdb_terms.HELIUM_RESPONSE_CODES.HE_ERR_OK) {
            throw new Error(`There was an error creating datastore: ${create_datastore_result[0][1]}`);
        }

        let insert_response = insertData(insert_object);
        log.info(create_datastore_result);
        log.info('insert object: ' + JSON.stringify(insert_object));
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
 * @param insert_obj
 * @returns {{skipped_hashes: *, update_hashes: *, message: string}}
 */
function insertData(insert_obj){
    try {
        let { schema_table, attributes } = insertUpdateValidate(insert_obj);
        let { datastores, rows } = heProcessRows(insert_obj, attributes, schema_table);
        let he_response = hdb_helium.insertRows(datastores, rows);
        let { written_hashes, skipped_hashes } = heProcessInsertUpdateResponse(he_response);
        convertOperationToTransaction(insert_obj, written_hashes, schema_table.hash_attribute);

        return returnObject(ACTION, written_hashes, insert_obj, skipped_hashes);
    } catch(err){
        throw (err);
    }
}
