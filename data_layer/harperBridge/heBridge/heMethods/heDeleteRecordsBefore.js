'use strict';

const hdb_utils = require('../../../../utility/common_utils');
const log = require('../../../../utility/logging/harper_logger');
const helium_utils = require('../../../../utility/helium/heliumUtils');
const hdb_terms = require('../../../../utility/hdbTerms');
const heGenerateDataStoreName = require('../heUtility/heGenerateDataStoreName');
const heDeleteRecords = require('./heDeleteRecords');

let hdb_helium;
try {
    hdb_helium = helium_utils.initializeHelium();
} catch(err) {
    throw err;
}

// Timestamp attribute to use when comparing with delete before date
const TIMESTAMP_ATTR = '__updatedtime__';
const RANGE_OPERATION = '<';

module.exports = heDeleteRecordsBefore;

/**
 * Deletes all records in a schema.table that fall behind a passed date.
 * @param delete_obj
 * {
 *     operation: 'delete_files_before' <string>,
 *     date: ISO-8601 format YYYY-MM-DD <string>,
 *     schema: Schema where table resides <string>,
 *     table: Table to delete records from <string>,
 * }
 * @returns {undefined}
 */
function heDeleteRecordsBefore(delete_obj) {
    let schema_table_hash = global.hdb_schema[delete_obj.schema][delete_obj.table].hash_attribute;
    if (hdb_utils.isEmptyOrZeroLength(schema_table_hash)) {
        throw new Error(`Could not retrieve hash attribute for schema: ${delete_obj.schema} table: ${delete_obj.table}`);
    }

    // Timestamps are originally created using Date.now() which is a millisecond string, passed dates are ISO format and
    // must be converted to milliseconds so that they can be compared with stored values.
    let parsed_search_date = Date.parse(delete_obj.date).toString();
    let search_result;

    // Uses helium api to search for values in a scheme.tables timestamp column that are less than passed date.
    try {
        search_result = hdb_helium.searchByValueRange(heGenerateDataStoreName(delete_obj.schema, delete_obj.table, TIMESTAMP_ATTR),
            RANGE_OPERATION, parsed_search_date, null, [heGenerateDataStoreName(delete_obj.schema, delete_obj.table, schema_table_hash)]);
    } catch(err) {
        log.error(`Error searching for date: ${delete_obj.date} in schema: ${delete_obj.schema} table: ${delete_obj.table}`);
        throw err;
    }

    let hashes_to_delete = [];
    for (let i = 0; i < search_result.length; i++) {
        hashes_to_delete.push(search_result[i][1][0]);
    }

    if (hdb_utils.isEmptyOrZeroLength(hashes_to_delete)) {
        log.trace('No records found to delete');
        return;
    }

    let delete_records_obj = {
        operation: hdb_terms.OPERATIONS_ENUM.DELETE,
        schema: delete_obj.schema,
        table: delete_obj.table,
        hash_values: hashes_to_delete
    };

    return heDeleteRecords(delete_records_obj);
}
