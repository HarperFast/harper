'use strict';

const WriteProcessorObject = require('../../../WriteProcessorObject');
const dataWriteProcessor = require('../../../dataWriteProcessor');
const env = require('../../../../utility/environment/environmentManager');
const hdb_terms = require('../../../../utility/hdbTerms');

// Search is used in the installer, and the base path may be undefined when search is instantiated.  Dynamically
// get the base path from the environment manager before using it.
let hdb_path = function() {
    return `${env.getHdbBasePath()}/${hdb_terms.HDB_SCHEMA_DIR}/`;
};

module.exports = processRows;

/**
 * Prepares data using HDB file system model in preparation for writing to storage
 * @param insert_obj
 * @param attributes
 * @param schema_table
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
