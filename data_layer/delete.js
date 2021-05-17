"use strict";

const bulkDeleteValidator = require('../validation/bulkDeleteValidator');
const deleteValidator = require('../validation/deleteValidator');
const common_utils = require('../utility/common_utils');
const moment = require('moment');
const harper_logger = require('../utility/logging/harper_logger');
const { promisify, callbackify } = require('util');
const terms = require('../utility/hdbTerms');
const global_schema = require('../utility/globalSchema');
const p_global_schema = promisify(global_schema.getTableSchema);
const harperBridge = require('./harperBridge/harperBridge');
const {DeleteResponseObject} = require('./DataLayerObjects');
const {DeleteBeforeObject} = require('./DeleteBeforeObject');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

const SUCCESS_MESSAGE = 'records successfully deleted';

// Callbackified functions
const cb_delete_record = callbackify(deleteRecord);

module.exports = {
    delete: cb_delete_record,
    deleteRecord,
    deleteFilesBefore: deleteFilesBefore,
    deleteTransactionLogsBefore
};

/**
 * Deletes files that have a system date before the date parameter.  Note this does not technically delete the values from the database,
 * so if clustering is enabled values added will still remain in a parent node.  This serves only to remove files for
 * devices that have a small amount of disk space.
 *
 * @param delete_obj - the request passed from chooseOperation.
 */
async function deleteFilesBefore(delete_obj) {
    let validation = bulkDeleteValidator(delete_obj, 'date');
    if (validation) {
        throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    let parsed_date = moment(delete_obj.date, moment.ISO_8601);
    if(!parsed_date.isValid()) {
        throw new Error("Invalid date, must be in ISO-8601 format (YYYY-MM-DD).");
    }

    let invalid_schema_table_msg = common_utils.checkSchemaTableExist(delete_obj.schema, delete_obj.table);
    if (invalid_schema_table_msg) {
        throw new Error(invalid_schema_table_msg);
    }

    try {
        let results = await harperBridge.deleteRecordsBefore(delete_obj);
        await p_global_schema(delete_obj.schema, delete_obj.table);
        harper_logger.info(`Finished deleting files before ${delete_obj.date}`);
        if(results && results.message){
            return results.message;
        }
    } catch (err) {
        throw err;
    }
}

/**
 * Deletes transaction logs which are older than a specific date
 *
 * @param {DeleteBeforeObject} delete_obj - the request passed from chooseOperation.
 */
async function deleteTransactionLogsBefore(delete_obj) {
    let validation = bulkDeleteValidator(delete_obj, 'timestamp');
    if (validation) {
        throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    if(isNaN(delete_obj.timestamp)) {
        throw new Error(`Invalid timestamp: ${delete_obj.timestamp}`);
    }

    let invalid_schema_table_msg = common_utils.checkSchemaTableExist(delete_obj.schema, delete_obj.table);
    if (invalid_schema_table_msg) {
        throw new Error(invalid_schema_table_msg);
    }

    try {
        let results = await harperBridge.deleteTransactionLogsBefore(delete_obj);
        await p_global_schema(delete_obj.schema, delete_obj.table);
        harper_logger.info(`Finished deleting transaction logs before ${delete_obj.timestamp}`);

        return results;
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
    let validation = deleteValidator(delete_object);
    if (validation) {
        throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    let invalid_schema_table_msg = common_utils.checkSchemaTableExist(delete_object.schema, delete_object.table);
    if (invalid_schema_table_msg) {
        throw handleHDBError(new Error(), invalid_schema_table_msg, HTTP_STATUS_CODES.NOT_FOUND, harper_logger.ERR, invalid_schema_table_msg);
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