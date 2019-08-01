'use strict';

/***
 * INSERT.JS
 *
 * This module is used to validate and insert or update data.  Note insert.update should be used over the update module,
 * as the update module is meant to be used in more specific circumstances.
 */

const insert_validator = require('../validation/insertValidator.js');
const path = require('path');
const h_utils = require('../utility/common_utils');
const search = require('./search');
const logger = require('../utility/logging/harper_logger');
const _ = require('lodash');
const env = require('../utility/environment/environmentManager');
const hdb_terms = require('../utility/hdbTerms');
const mkdirp = require('../utility/fs/mkdirp');
const write_file = require('../utility/fs/writeFile');
const unlink = require('../utility/fs/unlink');
const exploder = require('./dataWriteProcessor');
const util = require('util');
const ExplodedObject = require('./ExplodedObject');
const WriteProcessorObject = require('./WriteProcessorObject');
const hdb_bridge = require('./harperBridge/harperBridge');

// Search is used in the installer, and the base path may be undefined when search is instantiated.  Dynamically
// get the base path from the environment manager before using it.
let hdb_path = function() {
    return `${env.getHdbBasePath()}/schema/`;
};

//This is an internal value that should not be written to the DB.
//const HDB_PATH_KEY = hdb_terms.INSERT_MODULE_ENUM.HDB_PATH_KEY;
const CHUNK_SIZE = hdb_terms.INSERT_MODULE_ENUM.CHUNK_SIZE;

//for release 2.0 we need to turn off threading.  this variable will control the enable/disable
const ENABLE_THREADING = false;
const INTERNAL_ERROR_MESSAGE = 'An internal error occurred, please check the logs for more information.';
const ATTRIBUTE_ALREADY_EXISTS = 'attribute already exists';
const UPDATE_ACTION = 'updated';
const INSERT_ACTION = 'inserted';

module.exports = {
    insert: insertData,
    update: updateData,
    validation,
    checkForNewAttributes // There is jira out to see if we can remove this circular dependency CORE-440
};
//this must stay after the export to correct a circular dependency issue
const global_schema = require('../utility/globalSchema');

const p_global_schema = util.promisify(global_schema.getTableSchema);
const p_search_by_hash = util.promisify(search.searchByHash);

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

/**
 * Inserts data specified in the insert_object parameter.
 * @param insert_object
 */
async function insertData(insert_object){
    if (insert_object.operation !== 'insert') {
        throw new Error('invalid operation, must be insert');
    }

    try {
        let {schema_table, attributes} = await validation(insert_object);

        let hdb_bridge_result = await hdb_bridge.createRecords(insert_object, attributes, schema_table);

        //let { written_hashes, skipped, ...data_wrapper} = await processRows(insert_object, attributes, schema_table, epoch, null);
        //await checkForNewAttributes(insert_object.hdb_auth_header, schema_table, attributes);
        //await processData(data_wrapper);
        convertOperationToTransaction(insert_object, hdb_bridge_result.written_hashes, schema_table.hash_attribute);

        return returnObject(INSERT_ACTION, hdb_bridge_result.written_hashes, insert_object, hdb_bridge_result.skipped_hashes);
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
    try {
        let epoch = Date.now();

        if (update_object.operation !== 'update') {
            throw new Error('invalid operation, must be update');
        }

        let {table_schema, hashes, attributes} = await validation(update_object);
        let existing_rows = await getExistingRows(table_schema, hashes, attributes);

        // If no hashes are existing skip update attempts
        if(h_utils.isEmptyOrZeroLength(existing_rows)){
            return returnObject(UPDATE_ACTION, [], update_object, hashes);
        }

        let existing_map = _.keyBy(existing_rows, function(record) {
            return record[table_schema.hash_attribute];
        });

        let { written_hashes, skipped, unlinks, ...data_wrapper} = await processRows(update_object, attributes, table_schema, epoch, existing_map);
        await checkForNewAttributes(update_object.hdb_auth_header, table_schema, attributes);
        await unlinkFiles(unlinks);
        await processData(data_wrapper);
        convertOperationToTransaction(update_object, written_hashes, table_schema.hash_attribute);

        return returnObject(UPDATE_ACTION, written_hashes, update_object, skipped);
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

/**
 * performs a bulk search_by_hash for the defined hashes
 * @param table_schema
 * @param hashes
 * @param attributes
 * @returns {Promise<void>}
 */
async function getExistingRows(table_schema, hashes, attributes){
    try {
        let existing_attributes = checkForExistingAttributes(table_schema, attributes);
        if (h_utils.isEmptyOrZeroLength(existing_attributes)) {
            throw new Error('no attributes to update');
        }

        let search_object = {
            schema: table_schema.schema,
            table: table_schema.name,
            hash_values: hashes,
            get_attributes: existing_attributes
        };

        let existing_records = await p_search_by_hash(search_object);
        return existing_records;
    } catch(e) {
        logger.error(e);
        throw new Error(e);
    }
}

// /**
//  * Prepares data for writing to storage
//  * @param insert_object
//  * @param attributes
//  * @param table_schema
//  * @param epoch
//  * @param existing_rows
//  * @returns {Promise<ExplodedObject>}
//  */
// async function processRows(insert_object, attributes, table_schema, epoch, existing_rows){
//     let exploder_object = new WriteProcessorObject(hdb_path(), insert_object.operation, insert_object.records, table_schema, attributes, epoch, existing_rows);
//     let data_wrapper = await exploder(exploder_object);
//
//     return data_wrapper;
// }

/**
 * deletes files in bulk
 * @param unlink_paths
 */
async function unlinkFiles(unlink_paths) {
    try {
        await unlink(unlink_paths);
    } catch(e) {
        logger.error(e);
    }
}

// /**
//  * wrapper function that orchestrates the record creation on disk
//  * @param data_wrapper
//  */
// async function processData(data_wrapper) {
//     try {
//         await createFolders(data_wrapper.folders);
//         await writeRawDataFiles(data_wrapper.raw_data);
//     } catch(err) {
//         throw err;
//     }
// }

// /**
//  * writes the raw data files to disk
//  * @param data
//  */
// async function writeRawDataFiles(data) {
//     try {
//         await write_file(data);
//     } catch(e) {
//         logger.error(e);
//     }
// }

/**
 * creates all of the folders necessary to hold the raw files and hard links
 * @param folders
 */
async function createFolders(folders) {
    try {
        await mkdirp(folders, {mode:  hdb_terms.HDB_FILE_PERMISSIONS});
    } catch (e) {
        logger.error(e);
    }
}

/**
 * Compares the existing schema attributes to the
 * @param hdb_auth_header
 * @param table_schema
 * @param data_attributes
 * @returns {Promise<void>}
 */
async function checkForNewAttributes(hdb_auth_header, table_schema, data_attributes){
    try {
        if (h_utils.isEmptyOrZeroLength(data_attributes)) {
            return;
        }

        let raw_attributes = [];
        if (!h_utils.isEmptyOrZeroLength(table_schema.attributes)) {
            table_schema.attributes.forEach((attribute) => {
                raw_attributes.push(attribute.attribute);
            });
        }

        let new_attributes = data_attributes.filter(attribute => {
            return raw_attributes.indexOf(attribute) < 0;
        });

        if (new_attributes.length === 0) {
            return;
        }

        await Promise.all(
            new_attributes.map(async attribute => {
                await createNewAttribute(hdb_auth_header, table_schema.schema, table_schema.name, attribute);
            })
        );
    } catch(e){
        logger.error(e);
        throw new Error(e);
    }
}

/**
 * Compares the existing schema attributes to attributes from a record set and returns only the ones that exist
 * @param table_schema
 * @param data_attributes
 * @returns {*[]}
 */
function checkForExistingAttributes(table_schema, data_attributes){
    if(h_utils.isEmptyOrZeroLength(data_attributes)){
        return;
    }

    let raw_attributes = [];
    if(!h_utils.isEmptyOrZeroLength(table_schema.attributes)){
        table_schema.attributes.forEach((attribute)=>{
            raw_attributes.push(attribute.attribute);
        });
    }

    let existing_attributes = data_attributes.filter(attribute =>{
        return raw_attributes.indexOf(attribute) >= 0;
    });

    return existing_attributes;
}


/**
 * check the existing schema and creates new attributes based on what the incoming records have
 * @param hdb_auth_header
 * @param schema
 * @param table
 * @param attribute
 */
async function createNewAttribute(hdb_auth_header,schema, table, attribute) {
    // TODO CORE-113 - remove circular dependency.
    const schema_mod = require('./schema');

    let attribute_object = {
        schema:schema,
        table:table,
        attribute:attribute
    };

    if(hdb_auth_header){
        attribute_object.hdb_auth_header = hdb_auth_header;
    }

    try {
        await schema_mod.createAttribute(attribute_object);
    } catch(e){
        //if the attribute already exists we do not want to stop the insert
        if(typeof e === 'object' && e.message !== undefined && e.message.includes(ATTRIBUTE_ALREADY_EXISTS)){
            logger.warn(e);
        } else {
            throw e;
        }
    }
}
