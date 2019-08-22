'use strict';

const log = require('../../../../utility/logging/harper_logger');
const schema_validator = require('../../../../validation/schema_validator');
const hdb_utils = require('../../../../utility/common_utils');
const hdb_core_global_schema = require('../../../../utility/globalSchema');
const env = require('../../../../utility/environment/environmentManager');
const hdb_terms = require('../../../../utility/hdbTerms');
const mkdirp = require('../../../../utility/fs/mkdirp');
const writeFile = require('../../../../utility/fs/writeFile');
const insert_validator = require('../../../../validation/insertValidator');
const WriteProcessorObject = require('../../../WriteProcessorObject');
const dataWriteProcessor = require('../../../dataWriteProcessor');
const uuidV4 = require('uuid/v4');
const util = require('util');

const INSERT_ACTION = 'inserted';
let p_global_schema = util.promisify(hdb_core_global_schema.getTableSchema);
let hdb_path = function() {
    return `${env.getHdbBasePath()}/schema/`;
};

// TODO: this is temporary, it will be updated when search by value is added to the bridge.
const hdb_core_search = require('../../../search');
let p_search_search_by_value = util.promisify(hdb_core_search.searchByValue);

module.exports = createAttribute;

/** NOTE **
 * Due to circular dependencies with insertData in insert.js we have a duplicate version
 * of insertData in this file. It is only to be used by this function.
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

        log.info('insert object: ' + JSON.stringify(insert_object));
        let insert_response = await insertData(insert_object);
        log.info('attribute: ' + record.attribute);
        log.info(insert_response);

        return insert_response;
    } catch(err) {
        throw err;
    }
}

async function insertData(insert_object){
    try {
        let {schema_table, attributes} = await validation(insert_object);
        let { written_hashes, skipped_hashes, ...data_wrapper} = await processRows(insert_object, attributes, schema_table, null);
        await processData(data_wrapper);
        convertOperationToTransaction(insert_object, written_hashes, schema_table.hash_attribute);

        return returnObject(INSERT_ACTION, written_hashes, insert_object, skipped_hashes);
    } catch(e){
        throw (e);
    }
}

/**
 * Takes an insert/update object and validates attributes, also looks for dups and get a list of all attributes from the record set
 * @param {Object} write_object
 * @returns {Promise<{table_schema, hashes: any[], attributes: string[]}>}
 */
async function validation(write_object){
    // Need to validate these outside of the validator as the getTableSchema call will fail with
    // invalid values.

    if(hdb_utils.isEmpty(write_object)) {
        throw new Error('invalid update parameters defined.');
    }
    if(hdb_utils.isEmptyOrZeroLength(write_object.schema) ) {
        throw new Error('invalid schema specified.');
    }
    if(hdb_utils.isEmptyOrZeroLength(write_object.table) ) {
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

        if (is_update && hdb_utils.isEmptyOrZeroLength(record[hash_attribute])) {
            throw new Error('a valid hash attribute must be provided with update record');
        }

        if (!hdb_utils.isEmpty(record[hash_attribute]) && record[hash_attribute] !== '' && dups.has(hdb_utils.autoCast(record[hash_attribute]))){
            record.skip = true;
        }

        dups.add(hdb_utils.autoCast(record[hash_attribute]));

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
        let exploder_object = new WriteProcessorObject(hdb_path(), insert_obj.operation, insert_obj.records, schema_table, attributes, epoch, existing_rows);
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
