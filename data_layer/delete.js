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

    if (common_utils.isEmptyOrZeroLength(delete_obj.schema)) {
        throw new Error('Invalid schema.');
    }

    if (common_utils.isEmptyOrZeroLength(delete_obj.table)) {
        throw new Error('Invalid table.');
    }

    let check_schema_table_exist = common_utils.checkSchemaTableExist(delete_obj.schema, delete_obj.table);
    if (check_schema_table_exist) {
        throw new Error(check_schema_table_exist);
    }

    try {
        await harperBridge.deleteRecordsBefore(delete_obj);
        await p_global_schema(delete_obj.schema, delete_obj.table);
        harper_logger.info(`Finished deleting files before ${delete_obj.date}`);
    } catch (err) {
        throw err;
    }
}

/**
 * Calls the harper bridge to delete records.
 * @param delete_object
 * @returns {Promise<string>}
 */
async function deleteRecord(delete_object) {
    let validation = bulk_delete_validator(delete_object);
    if (validation) {
        throw validation;
    }

    let check_schema_table_exist = common_utils.checkSchemaTableExist(delete_object.schema, delete_object.table);
    if (check_schema_table_exist) {
        throw new Error(check_schema_table_exist);
    }

    try {
        await p_global_schema(delete_object.schema, delete_object.table);
        let delete_result_object = await harperBridge.deleteRecords(delete_object);

        if (common_utils.isEmptyOrZeroLength(delete_result_object.message)) {
            delete_result_object.message = `${delete_result_object.deleted_hashes.length} of ${delete_object.hash_values.length} ${SUCCESS_MESSAGE}`;
        }
        return delete_result_object;
    } catch (err) {
        if(err.message === terms.SEARCH_NOT_FOUND_MESSAGE) {
            let return_msg = new DeleteResponseObject();
            return_msg.message = terms.SEARCH_NOT_FOUND_MESSAGE;
            return_msg.skipped_hashes = delete_object.hash_values.length;
            return_msg.deleted_hashes = 0;
            return return_msg;
        }

        throw err;
    }
}