'use strict';

/***
 * INSERT.JS
 *
 * This module is used to validate and insert or update data.  Note insert.update should be used over the update module,
 * as the update module is meant to be used in more specific circumstances.
 */
const insert_validator = require('../validation/insertValidator.js');
const h_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const util = require('util');
// Leave this unused signalling import here. Due to circular dependencies we bring it in early to load it before the bridge
const signalling = require('../utility/signalling');
const harperBridge = require('./harperBridge/harperBridge');
const global_schema = require('../utility/globalSchema');

const p_global_schema = util.promisify(global_schema.getTableSchema);
const p_schema_to_global = util.promisify(global_schema.setSchemaDataToGlobal);


//for release 2.0 we need to turn off threading.  this variable will control the enable/disable
const ENABLE_THREADING = false;
const ATTRIBUTE_ALREADY_EXISTS = 'attribute already exists';
const UPDATE_ACTION = 'updated';
const INSERT_ACTION = 'inserted';

const log = require('../utility/logging/harper_logger');

module.exports = {
    insert: insertData,
    update: updateData,
    validation
};


// TODO: We have duplicate validation code, here and in the bridge.
/**
 *  Takes an insert/update object and validates attributes, also looks for dups and get a list of all attributes from the record set
 * @param {Object} write_object
 * @returns {Promise<{table_schema, hashes: any[], attributes: string[]}>}
 */
async function validation(write_object){
    // Need to validate these outside of the validator as the getTableSchema call will fail with
    // invalid values.

    if(h_utils.isEmpty(write_object)) {
        throw new Error('invalid update parameters defined.');
    }
    if(h_utils.isEmptyOrZeroLength(write_object.schema) ) {
        throw new Error('invalid schema specified.');
    }
    if(h_utils.isEmptyOrZeroLength(write_object.table) ) {
        throw new Error('invalid table specified.');
    }

    let schema_table = await p_global_schema(write_object.schema, write_object.table);

    //validate insert_object for required attributes
    let validator = insert_validator(write_object);
    if (validator) {
        throw validator;
    }

    if(!Array.isArray(write_object.records)) {
        throw new Error('records must be an array');
    }

    let hash_attribute = schema_table.hash_attribute;
    let dups = new Set();
    let attributes = {};

    let is_update = false;
    if (write_object.operation === 'update') {
        is_update = true;
    }

    write_object.records.forEach((record)=>{

        if (is_update && h_utils.isEmptyOrZeroLength(record[hash_attribute])) {
            throw new Error('a valid hash attribute must be provided with update record');
        }

        if (!h_utils.isEmpty(record[hash_attribute]) && record[hash_attribute] !== '' && dups.has(h_utils.autoCast(record[hash_attribute]))){
            record.skip = true;
        }

        dups.add(h_utils.autoCast(record[hash_attribute]));

        for (let attr in record) {
            attributes[attr] = 1;
        }
    });

    //in case the hash_attribute was not on the object(s) for inserts where they want to auto-key we manually add the hash_attribute to attributes
    attributes[hash_attribute] = 1;

    return {
        schema_table: schema_table,
        hashes: Array.from(dups),
        attributes: Object.keys(attributes)
    };
}

/** NOTE **
 * Due to circular dependencies between insert.js and schema.js, specifically around createNewAttribute, there
 * is duplicate insertData code in fsCreateAttribute. If you change something here related to insertData, you should
 * do the same in fsCreateAttribute.js
 */

/**
 * Inserts data specified in the insert_object parameter.
 * @param insert_object
 */
async function insertData(insert_object){
    if (insert_object.operation !== 'insert') {
        throw new Error('invalid operation, must be insert');
    }

    try {
        let bridge_insert_result = await harperBridge.createRecords(insert_object);
        convertOperationToTransaction(insert_object, bridge_insert_result.written_hashes, bridge_insert_result.schema_table.hash_attribute);
        await p_schema_to_global();

        return returnObject(INSERT_ACTION, bridge_insert_result.written_hashes, insert_object, bridge_insert_result.skipped_hashes);
    } catch(e){
        throw (e);
    }
}

function convertOperationToTransaction(write_object, written_hashes, hash_attribute){
    if(global.hdb_socket_client !== undefined && write_object.schema !== 'system' && Array.isArray(written_hashes) && written_hashes.length > 0){
        let transaction = {
            operation: write_object.operation,
            schema: write_object.schema,
            table: write_object.table,
            records:[]
        };

        write_object.records.forEach(record =>{
            if(written_hashes.indexOf(h_utils.autoCast(record[hash_attribute])) >= 0) {
                transaction.records.push(record);
            }
        });
        let insert_msg = h_utils.getClusterMessage(hdb_terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
        insert_msg.transaction = transaction;
        h_utils.sendTransactionToSocketCluster(`${write_object.schema}:${write_object.table}`, insert_msg);
    }
}

/**
 * Updates the data in the update_object parameter.
 * @param update_object - The data that will be updated in the database
 */
async function updateData(update_object){
    if (update_object.operation !== 'update') {
        throw new Error('invalid operation, must be update');
    }
    try {
        let bridge_update_result = await harperBridge.updateRecords(update_object);
        if (!h_utils.isEmpty(bridge_update_result.existing_rows)) {
            return returnObject(bridge_update_result.update_action, [], update_object, bridge_update_result.hashes);
        }
        convertOperationToTransaction(update_object, bridge_update_result.written_hashes, bridge_update_result.schema_table.hash_attribute);

        return returnObject(UPDATE_ACTION, bridge_update_result.written_hashes, update_object, bridge_update_result.skipped_hashes);
    } catch(e){
        throw (e);
    }
}

/**
 * constructs return object for insert and update.
 * @param action
 * @param written_hashes
 * @param object
 * @param skipped
 * @returns {{skipped_hashes: *, update_hashes: *, message: string}}
 */
function returnObject(action, written_hashes, object, skipped) {
    let return_object = {
        message: `${action} ${written_hashes.length} of ${object.records.length} records`,
        skipped_hashes: skipped
    };

    if (action === INSERT_ACTION) {
        return_object.inserted_hashes = written_hashes;
        return return_object;
    }

    return_object.update_hashes = written_hashes;
    return return_object;
}
