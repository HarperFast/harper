'use strict';

const log = require('../../../../utility/logging/harper_logger');
const schema_validator = require('../../../../validation/schema_validator');
const hdb_utils = require('../../../../utility/common_utils');
const env = require('../../../../utility/environment/environmentManager');
const hdb_terms = require('../../../../utility/hdbTerms');
const insertUpdateValidate = require('../fsUtility/insertUpdateValidate');
const mkdirp = require('../../../../utility/fs/mkdirp');
const writeFile = require('../../../../utility/fs/writeFile');
const WriteProcessorObject = require('../../../WriteProcessorObject');
const dataWriteProcessor = require('../../../dataWriteProcessor');
const uuidV4 = require('uuid/v4');
const util = require('util');

const INSERT_ACTION = 'inserted';
const HDB_PATH = `${env.getHdbBasePath()}/${hdb_terms.HDB_SCHEMA_DIR}/`;

// TODO: this is temporary, it will be updated when search by value is added to the bridge.
const hdb_core_search = require('../../../search');
let p_search_search_by_value = util.promisify(hdb_core_search.searchByValue);

module.exports = createAttribute;

/** NOTE **
 * Due to circular dependencies with insertData in insert.js we have a duplicate version
 * of insertData in this file. It should only be used by createAttribute.
 * **/

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

    let search_object = {
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        table: hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
        hash_attribute: hdb_terms.SYSTEM_TABLE_HASH,
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
            operation: hdb_terms.OPERATIONS_ENUM.INSERT,
            schema: hdb_terms.SYSTEM_SCHEMA_NAME,
            table: hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
            hash_attribute: hdb_terms.SYSTEM_TABLE_HASH,
            records: [record]
        };

        log.info('insert object: ' + JSON.stringify(insert_object));
        let insert_response = await insertData(insert_object);
        log.info('attribute: ' + record.attribute);
        log.info(insert_response);

        return insert_response;
    } catch(err) {
        throw err;
    }
}

/**
 * Inserts data specified in the insert_object parameter.
 * @param insert_object
 * @returns {Promise<{skipped_hashes: *, update_hashes: *, message: string}>}
 */
async function insertData(insert_object){
    try {
        let { schema_table, attributes } = await insertUpdateValidate(insert_object);
        let { written_hashes, skipped_hashes, ...data_wrapper } = await processRows(insert_object, attributes, schema_table, null);
        await processData(data_wrapper);
        convertOperationToTransaction(insert_object, written_hashes, schema_table.hash_attribute);

        return returnObject(INSERT_ACTION, written_hashes, insert_object, skipped_hashes);
    } catch(err){
        throw (err);
    }
}

/**
 * Prepares data using HDB file system model in preparation for writing to storage
 * @param insert_obj
 * @param attributes
 * @param table_schema
 * @param existing_rows
 * @returns {Promise<ExplodedObject>}
 */
async function processRows(insert_obj, attributes, schema_table, existing_rows){
    let epoch = Date.now();

    try {
        let exploder_object = new WriteProcessorObject(HDB_PATH, insert_obj.operation, insert_obj.records, schema_table, attributes, epoch, existing_rows);
        let data_wrapper = await dataWriteProcessor(exploder_object);

        return data_wrapper;
    } catch(err) {
        throw err;
    }
}

/**
 * Wrapper function that orchestrates the record creation on disk
 * @param data_wrapper
 */
async function processData(data_wrapper) {
    try {
        await createFolders(data_wrapper.folders);
        await writeRawDataFiles(data_wrapper.raw_data);
    } catch(err) {
        throw err;
    }
}

/**
 * creates all of the folders necessary to hold the raw files and hard links
 * @param folders
 */
async function createFolders(folders) {
    try {
        await mkdirp(folders, {mode:  hdb_terms.HDB_FILE_PERMISSIONS});
    } catch (err) {
        throw err;
    }
}

/**
 * writes the raw data files to disk
 * @param data
 */
async function writeRawDataFiles(data) {
    try {
        await writeFile(data);
    } catch(err) {
        throw err;
    }
}

// This will be updated soon by Eli, hence the lack of unit tests
function convertOperationToTransaction(write_object, written_hashes, hash_attribute){
    if(global.hdb_socket_client !== undefined && write_object.schema !== 'system' && Array.isArray(written_hashes) && written_hashes.length > 0){
        let transaction = {
            operation: write_object.operation,
            schema: write_object.schema,
            table: write_object.table,
            records:[]
        };

        write_object.records.forEach(record =>{
            if(written_hashes.indexOf(hdb_utils.autoCast(record[hash_attribute])) >= 0) {
                transaction.records.push(record);
            }
        });
        let insert_msg = hdb_utils.getClusterMessage(hdb_terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
        insert_msg.transaction = transaction;
        hdb_utils.sendTransactionToSocketCluster(`${write_object.schema}:${write_object.table}`, insert_msg);
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
