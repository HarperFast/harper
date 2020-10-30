'use strict';

const SearchObject = require('../../../SearchObject');
const hdb_utils = require('../../../../utility/common_utils');
const log = require('../../../../utility/logging/harper_logger');
const search_by_value = require('./lmdbSearchByValue');
const hdb_terms = require('../../../../utility/hdbTerms');
const delete_records = require('../../../../utility/lmdb/deleteUtility').deleteRecords;
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const path = require('path');
const {getBaseSchemaPath} = require('../lmdbUtility/initializePaths');

const {promisify} = require('util');
const p_timeout = promisify(setTimeout);

const DELETE_CHUNK = 10000;
const DELETE_PAUSE_MS = 10;

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

    return await chunkDeletes(delete_obj, search_result, schema_table_hash);
}

/**
 * chunks the deletes and executes them in batches with a pause between each chunk iteration.
 * @param delete_obj
 * @param deletes
 * @param schema_table_hash
 * @returns {Promise<{skipped_hashes: [], deleted_hashes: [], message: string}>}
 */
async function chunkDeletes(delete_obj, deletes, schema_table_hash){
    let env_base_path = path.join(getBaseSchemaPath(), delete_obj.schema.toString());
    let environment = await environment_utility.openEnvironment(env_base_path, delete_obj.table);

    let total_results = {
        message:'',
        deleted_hashes:[],
        skipped_hashes:[]
    };

    for (let i = 0, length = deletes.length; i < length; i += DELETE_CHUNK) {
        let chunk = deletes.slice(i, i + DELETE_CHUNK);
        let ids = [];
        for(let x = 0, chunk_length = chunk.length; x < chunk_length; x++){
            ids.push(chunk[x][schema_table_hash]);
        }

        try {
            let result = delete_records(environment, schema_table_hash, ids);
            total_results.deleted_hashes = total_results.deleted_hashes.concat(result.deleted);
            total_results.skipped_hashes = total_results.skipped_hashes.concat(result.skipped);
        } catch(err) {
            throw err;
        }
        await p_timeout(DELETE_PAUSE_MS);
    }

    total_results.message = `${total_results.deleted_hashes.length} of ${total_results.deleted_hashes.length + total_results.skipped_hashes.length} records successfully deleted`;
    return total_results;
}