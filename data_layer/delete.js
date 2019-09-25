"use strict";

const env = require('../utility/environment/environmentManager');
const bulk_delete_validator = require('../validation/bulkDeleteValidator');
const common_utils = require('../utility/common_utils');
const moment = require('moment');
const harper_logger = require('../utility/logging/harper_logger');
const { promisify, callbackify } = require('util');
const terms = require('../utility/hdbTerms');
const global_schema = require('../utility/globalSchema');
const p_global_schema = promisify(global_schema.getTableSchema);
const harperBridge = require('./harperBridge/harperBridge');
const {DeleteResponseObject} = require('./DataLayerObjects');

const SUCCESS_MESSAGE = 'records successfully deleted';

// Callbackified functions
const cb_delete_record = callbackify(deleteRecord);

module.exports = {
    delete: cb_delete_record,
    deleteRecord,
    deleteFilesBefore: deleteFilesBefore
};

/**
 * Deletes files that have a system date before the date parameter.  Note this does not technically delete the values from the database,
 * so if clustering is enabled values added will still remain in a parent node.  This serves only to remove files for
 * devices that have a small amount of disk space.
 *
 * @param delete_obj - the request passed from chooseOperation.
 * @param callback
 */
async function deleteFilesBefore(delete_obj) {
    if(common_utils.isEmptyOrZeroLength(delete_obj.date)) {
        throw new Error("Invalid date.");
    }

    let parsed_date = moment(delete_obj.date, moment.ISO_8601);
    if(!parsed_date.isValid()) {
        throw new Error("Invalid date, must be in ISO-8601 format (YYYY-MM-DD).");
    }

    if(common_utils.isEmptyOrZeroLength(delete_obj.schema)) {
        throw new Error("Invalid schema.");
    }

    if(common_utils.isEmptyOrZeroLength(delete_obj.table)) {
        throw new Error("Invalid table.");
    }

    await harperBridge.deleteRecordsBefore(delete_obj);
    await p_global_schema(delete_obj.schema, delete_obj.table);

    harper_logger.info(`Finished deleting files before ${delete_obj.date}`);
}

/**
 * Calls the harper bridge to delete records.
 * @param delete_object
 * @returns {Promise<string>}
 */
async function deleteRecord(delete_object){
    let validation = bulk_delete_validator(delete_object);
    if (validation) {
        throw validation;
    }

    try {
        let not_found_hashes = [];
        await p_global_schema(delete_object.schema, delete_object.table);
        compareSearchResultsWithRequest.bind(null, not_found_hashes, delete_object);
        let delete_result_object = await harperBridge.deleteRecords(delete_object);

        // append records not found to skipped
        if(not_found_hashes && not_found_hashes.length > 0) {
            for(let i=0; i<not_found_hashes.length; ++i) {
                delete_result_object.skipped_hashes.push(not_found_hashes[i]);
            }
        }

        if(delete_object.schema !== terms.SYSTEM_SCHEMA_NAME) {
            let delete_msg = common_utils.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
            delete_msg.transaction = delete_object;
            common_utils.sendTransactionToSocketCluster(`${delete_object.schema}:${delete_object.table}`, delete_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
        }

        if(common_utils.isEmptyOrZeroLength(delete_result_object.message)) {
            delete_result_object.message = `${delete_result_object.deleted_hashes.length} of ${delete_object.hash_values.length} ${SUCCESS_MESSAGE}`;
        }
        return delete_result_object;
    } catch(err){
        if(err.message === terms.SEARCH_NOT_FOUND_MESSAGE) {
            let return_msg = new DeleteResponseObject();
            return_msg.message = terms.SEARCH_NOT_FOUND_MESSAGE;
            return_msg.skipped_hashes = delete_object.hash_values.length;
            return_msg.deleted_hashes = 0;
            return return_msg;
        }
    }
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
function compareSearchResultsWithRequest(not_found_hashes, delete_object, records) {
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
        for(let search_result_index = 0; search_result_index < records.length; ++search_result_index) {
            if(records[search_result_index][table_hash_attribute] === delete_object.hash_values[i]) {
                was_returned = true;
                break;
            }
        }
        if(!was_returned) {
            not_found_hashes.push(delete_object.hash_values[i]);
        }
    }
    return records;
}