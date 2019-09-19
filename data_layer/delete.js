"use strict";

const env = require('../utility/environment/environmentManager');
const bulk_delete_validator = require('../validation/bulkDeleteValidator');
const conditional_delete_validator = require('../validation/conditionalDeleteValidator');
const common_utils = require('../utility/common_utils');
const async = require('async');
const moment = require('moment');
const harper_logger = require('../utility/logging/harper_logger');
const { promisify, callbackify } = require('util');
const terms = require('../utility/hdbTerms');
const global_schema = require('../utility/globalSchema');
const p_global_schema = promisify(global_schema.getTableSchema);
const search = require('./search');
const harperBridge = require('./harperBridge/harperBridge');

const SUCCESS_MESSAGE = 'records successfully deleted';

// Callbackified functions
const cb_delete_record = callbackify(deleteRecord);

module.exports = {
    delete: cb_delete_record,
    deleteRecord,
    conditionalDelete: conditionalDelete,
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
        await p_global_schema(delete_object.schema, delete_object.table);
        await harperBridge.deleteRecords(delete_object);

        if(delete_object.schema !== terms.SYSTEM_SCHEMA_NAME) {
            let delete_msg = common_utils.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
            delete_msg.transaction = delete_object;
            common_utils.sendTransactionToSocketCluster(`${delete_object.schema}:${delete_object.table}`, delete_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
        }

        return SUCCESS_MESSAGE;
    } catch(err){
        harper_logger.error(err);
        throw err;
    }
}

function conditionalDelete(delete_object, callback){
    try {
        let validation = conditional_delete_validator(delete_object);
        if (validation) {
            callback(validation);
            return;
        }

        async.waterfall([
            global_schema.getTableSchema.bind(null, delete_object.schema, delete_object.table),
            (table_info, callback) => {
                callback(null, delete_object.conditions, table_info);
            },
            search.multiConditionSearch,
            (ids, callback) => {
                let delete_wrapper = {
                    schema: delete_object.schema,
                    table: delete_object.table,
                    hash_values: ids
                };
                callback(null, delete_wrapper);
            },
            deleteRecord
        ], (err) => {
            if (err) {
                callback(err);
                return;
            }
            callback(null, SUCCESS_MESSAGE);
        });
    } catch(e) {
        callback(e);
    }
}
