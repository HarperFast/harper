'use strict';

const fsSearchByHash = require('./fsSearchByHash');
const getBasePath = require('../fsUtility/getBasePath');
const log = require('../../../../utility/logging/harper_logger');
const common_utils = require('../../../../utility/common_utils');
const unlink = require('../../../../utility/fs/unlink');
const terms = require('../../../../utility/hdbTerms');
const truncate = require('truncate-utf8-bytes');

const slash_regex = /\//g;
const MAX_BYTES = '255';
const BLOB_FOLDER_NAME = 'blob';
const SUCCESS_MESSAGE = 'records successfully deleted';

module.exports = deleteRecords;

async function deleteRecords(delete_obj){
    let hash_attribute = null;
    let delete_response_object = undefined;
    let not_found_hashes = [];
    try {
        if (!delete_obj.records) {
            let search_object = {
                schema: delete_obj.schema,
                table: delete_obj.table,
                hash_values: delete_obj.hash_values,
                get_attributes: ['*']
            };
            delete_obj.records = await fsSearchByHash(search_object);
        }
    } catch(err) {
        log.error(err);
        throw err;
    }

    hash_attribute = global.hdb_schema[delete_obj.schema][delete_obj.table].hash_attribute;
    if (common_utils.isEmpty(hash_attribute)) {
        log.error(`could not retrieve hash attribute for schema:${delete_obj.schema} and table ${delete_obj.table}`);
        throw new Error(`hash attribute not found`);
    }

    let table_path = common_utils.buildFolderPath(getBasePath(), delete_obj.schema, delete_obj.table);

    //generate the paths for each file to delete.  Store these in a map from hash_attribute to paths so we can determine
    // if there were any failures and report back.
    let hash_attribute_path_map = Object.create(null);
    try {
        delete_obj.records.forEach((record) => {
            Object.keys(record).forEach((attribute) => {
                let hash_value = record[hash_attribute];

                if (!common_utils.isEmptyOrZeroLength(hash_value)) {
                    if (!hash_attribute_path_map[hash_value]) {
                        hash_attribute_path_map[hash_value] = [];
                    }
                    hash_attribute_path_map[hash_value].push(common_utils.buildFolderPath(table_path, terms.HASH_FOLDER_NAME, attribute, `${hash_value}${terms.HDB_FILE_SUFFIX}`));

                    let value = record[attribute];
                    if (common_utils.isObject(value)) {
                        value = JSON.stringify(value);
                    }

                    let stripped_value = String(value).replace(slash_regex, '');
                    stripped_value = stripped_value.length > MAX_BYTES ? common_utils.buildFolderPath(truncate(stripped_value, MAX_BYTES), BLOB_FOLDER_NAME) : stripped_value;
                    let path = common_utils.buildFolderPath(table_path, attribute, stripped_value, `${hash_value}${terms.HDB_FILE_SUFFIX}`);
                    // This `includes` is icky and slow, but we need to make sure we don`t have duplicate paths, as a failure to remove
                    // an already removed file will be reported as a failure to delete.  The alternative
                    // is to keep a separate path `index` object which we can compare to before the push, but that could lead
                    // to memory bloat.  Just gonna have to swallow the inefficiency.
                    if (!hash_attribute_path_map[hash_value].includes(path)) {
                        hash_attribute_path_map[hash_value].push(path);
                    }
                }
            });
        });
    } catch(err) {
        log.error('There was an error picking delete paths.');
        log.error(err);
    }

    try {
        delete_response_object = await unlink.unlink_delete_object(hash_attribute_path_map);
        if(!common_utils.isEmptyOrZeroLength(delete_obj.hash_values)) {
            compareSearchResultsWithRequest(not_found_hashes, delete_obj);
        }
        // append records not found to skipped
        if(not_found_hashes && not_found_hashes.length > 0) {
            for(let i=0; i<not_found_hashes.length; ++i) {
                delete_response_object.skipped_hashes.push(not_found_hashes[i]);
            }
        }

    } catch(err) {
        log.error(err);
        throw common_utils.errorizeMessage(err);
    }
    return delete_response_object;
}

/**
 * Used in a waterfall to compare search results vs hashes specified in a request.  Any hashes not found in records
 * will be added to not_found_hashes.
 * @param not_found_hashes - array that is populated with skipped hash id values
 * @param delete_object - The object that will be passed to the delete function
 * @param records - records found during a search
 * @param callback
 * @returns {Object}
 */
function compareSearchResultsWithRequest(not_found_hashes, delete_object) {
    // check for records specified in the request, but were not found in the search.  Need to report those as
    // skipped.
    let table_hash_attribute = undefined;
    try {
        table_hash_attribute = global.hdb_schema[delete_object.schema][delete_object.table].hash_attribute;
    } catch(err) {
        common_utils.errorizeMessage(terms.SEARCH_ATTRIBUTE_NOT_FOUND);
    }

    for(let i=0; i<delete_object.hash_values.length; ++i) {
        let was_returned = false;
        for(let search_result_index = 0; search_result_index < delete_object.records.length; ++search_result_index) {
            if (delete_object.records[search_result_index][table_hash_attribute] === common_utils.autoCast(delete_object.hash_values[i])) {
                was_returned = true;
                break;
            }
        }
        if(!was_returned) {
            not_found_hashes.push(common_utils.autoCast(delete_object.hash_values[i]));
        }
    }
}
