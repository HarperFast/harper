'use strict';

const WriteProcessorObject = require('../../../WriteProcessorObject');
const dataWriteProcessor = require('../../../dataWriteProcessor');
const insertUpdateValidate = require('../fsUtility/insertUpdateValidate');
const mkdirp = require('../../../../utility/fs/mkdirp');
const hdb_terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');
const env = require('../../../../utility/environment/environmentManager');
const writeFile = require('../../../../utility/fs/writeFile');

// Search is used in the installer, and the base path may be undefined when search is instantiated.  Dynamically
// get the base path from the environment manager before using it.
let hdb_path = function() {
    return `${env.getHdbBasePath()}/schema/`;
};

module.exports = createRecords;

// This must be here to prevent issues with circular dependencies related to insert.checkForNewAttributes
const hdb_core_insert = require('../../../insert');

/**
 * Calls all the functions specifically responsible for writing data to the file system
 * @param insert_obj
 * @returns {Promise<{skipped_hashes, written_hashes, schema_table}>}
 */
async function createRecords(insert_obj) {
    try {
        let {schema_table, attributes} = await insertUpdateValidate(insert_obj);
        let data_wrapper = await processRows(insert_obj, attributes, schema_table);
        await hdb_core_insert.checkForNewAttributes(insert_obj.hdb_auth_header, schema_table, attributes);
        await processData(data_wrapper);

        let return_obj = {
            written_hashes: data_wrapper.written_hashes,
            skipped_hashes: data_wrapper.skipped,
            schema_table: schema_table
        };

        return return_obj;
    } catch(err) {
        log.error(err);
        throw err;
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

