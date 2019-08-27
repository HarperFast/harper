'use strict';

const insertUpdateValidate = require('../fsUtility/insertUpdateValidate');
const processData = require('../fsUtility/processData');
const processRows = require('../fsUtility/processRows');
const log = require('../../../../utility/logging/harper_logger');

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
            skipped_hashes: data_wrapper.skipped_hashes,
            schema_table
        };

        return return_obj;
    } catch(err) {
        log.error(err);
        throw err;
    }
}
