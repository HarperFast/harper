'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const heBuildDataStoreArray = require('../heUtility/heBuildDataStoreArray');
const log = require('../../../../utility/logging/harper_logger');

module.exports = processRows;

/**
 * Builds an array of datastores using passed attributes and a matching multi dimensional
 * array of row data. Adds current timestamp to created & updated columns.
 * @param insert_obj
 * @param attributes
 * @param schema_table
 * @returns {{datastores: *, rows: *}}
 */
function processRows(insert_obj, attributes, schema_table) {
    let {schema, table, records} = insert_obj;
    let rows = [];
    let hash_attribute = schema_table.hash_attribute;
    let timestamp = Date.now();
    let datastores = heBuildDataStoreArray(attributes, schema, table);
    let system_schema = insert_obj.schema === hdb_terms.SYSTEM_SCHEMA_NAME;

    // Iterates through array of record objects and validates their hash
    for (let x = 0; x < records.length; x++) {
        let row_records = [];
        validateHash(records[x], hash_attribute);

        // Builds a single row array with each record object. Matches each value to its attribute. If it doesn't contain any data
        // at attribute location a null will be inserted into row array.
        for (let y = 0; y < attributes.length; y++) {
            if (records[x].hasOwnProperty(attributes[y])) {
                row_records.push(records[x][attributes[y]]);
            } else {
                row_records.push(null);
            }
        }
        if (!system_schema) {
            // If inserting pushes two identical timestamps to end of row array. These correspond created time & updated time attributes.
            // On updated created time is skipped
            if (insert_obj.operation === hdb_terms.OPERATIONS_ENUM.INSERT) {
                row_records.push(timestamp, timestamp);
            } else {
                row_records.push(null, timestamp);
            }

        }

        // Pushes (nests) completed row inside array of all rows returned by function.
        rows.push([records[x][hash_attribute],row_records]);
    }

    if (!system_schema) {
        // Pushes created time and updated time attributes to datastores array
        datastores.push(`${schema}/${table}/${hdb_terms.HELIUM_TIME_STAMP_ENUM.CREATED_TIME}`);
        datastores.push(`${schema}/${table}/${hdb_terms.HELIUM_TIME_STAMP_ENUM.UPDATED_TIME}`);
    }

    return {
        datastores,
        rows
    };
}

/**
 * Validates hash value exists, under max char size and doesn't contain a forward slash.
 * @param record
 * @param hash_attribute
 */
function validateHash(record, hash_attribute) {
    if (!record.hasOwnProperty(hash_attribute)) {
        log.error(record);
        throw new Error('transaction aborted due to record(s) with no hash value, check log for more info');
    }

    if (Buffer.byteLength(String(record[hash_attribute])) > hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE) {
        log.error(record);
        throw new Error(`transaction aborted due to record(s) with a hash value that exceeds ${hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE} bytes, check log for more info`);
    }

    if (hdb_terms.FORWARD_SLASH_REGEX.test(record[hash_attribute])) {
        log.error(record);
        throw new Error('transaction aborted due to record(s) with a hash value that contains a forward slash, check log for more info');
    }
}
