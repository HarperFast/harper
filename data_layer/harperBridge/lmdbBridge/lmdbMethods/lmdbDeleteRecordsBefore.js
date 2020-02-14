'use strict';

const DeleteObject = require('../../../DeleteObject');
const SearchObject = require('../../../SearchObject');
const hdb_utils = require('../../../../utility/common_utils');
const log = require('../../../../utility/logging/harper_logger');
const search_by_value = require('./lmdbSearchByValue');
const hdb_terms = require('../../../../utility/hdbTerms');
const delete_records = require('./lmdbDeleteRecords');

module.exports = lmdbDeleteRecordsBefore;

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
async function lmdbDeleteRecordsBefore(delete_obj) {
    let schema_table_hash = global.hdb_schema[delete_obj.schema][delete_obj.table].hash_attribute;
    if (hdb_utils.isEmptyOrZeroLength(schema_table_hash)) {
        throw new Error(`Could not retrieve hash attribute for schema: ${delete_obj.schema} table: ${delete_obj.table}`);
    }

    // Timestamps are originally created using Date.now() which is a millisecond string, passed dates are ISO format and
    // must be converted to milliseconds so that they can be compared with stored values.
    let parsed_search_date = Date.parse(delete_obj.date).toString();
    let search_result;

    // Uses lmdb to search for values in a scheme.tables timestamp column that are less than passed date.
    try {
        // We currently compare passed timestamp to the created time attribute
        let search_obj = new SearchObject(delete_obj.schema, delete_obj.table, hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME, parsed_search_date, undefined, [schema_table_hash]);
        search_result = await search_by_value(search_obj, hdb_terms.VALUE_SEARCH_COMPARATORS.LESS);
    } catch(err) {
        log.error(`Error searching for date: ${delete_obj.date} in schema: ${delete_obj.schema} table: ${delete_obj.table}`);
        throw err;
    }

    if (hdb_utils.isEmptyOrZeroLength(search_result)) {
        log.trace('No records found to delete');
        return;
    }

    let hashes_to_delete = [];
    for (let i = 0; i < search_result.length; i++) {
        hashes_to_delete.push(search_result[i][schema_table_hash]);
    }

    let delete_object = new DeleteObject(delete_obj.schema, delete_obj.table, hashes_to_delete);

    try {
        return await delete_records(delete_object);
    } catch(err) {
        throw err;
    }
}