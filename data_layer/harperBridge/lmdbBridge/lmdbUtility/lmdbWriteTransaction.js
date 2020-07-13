'use strict';

const path = require('path');
const environment_util = require('../../../../utility/lmdb/environmentUtility');
const LMDBInsertTransactionObject = require('./LMDBInsertTransactionObject');
const LMDBUpdateTransactionObject = require('./LMDBUpdateTransactionObject');
const LMDBDeleteTransactionObject = require('./LMDBDeleteTransactionObject');

const InsertRecordsResponseObject = require('../../../../utility/lmdb/InsertRecordsResponseObject');
const UpdateRecordsResponseObject = require('../../../../utility/lmdb/UpdateRecordsResponseObject');
const DeleteRecordsResponseObject = require('../../../../utility/lmdb/DeleteRecordsResponseObject');

const InsertObject = require('../../../InsertObject');
const UpdateObject = require('../../../UpdateObject');
const DeleteObject = require('../../../DeleteObject');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const lmdb_utils = require('../../../../utility/lmdb/commonUtility');
const hdb_util = require('../../../../utility/common_utils');

const OPERATIONS_ENUM = require('../../../../utility/hdbTerms').OPERATIONS_ENUM;
const {getTransactionStorePath} = require('./initializePaths');

module.exports = writeTransaction;

/**
 *
 * @param {InsertObject|UpdateObject|DeleteObject} hdb_operation
 * @param {InsertRecordsResponseObject | UpdateRecordsResponseObject | DeleteRecordsResponseObject} lmdb_response
 * @returns {Promise<void>}
 */
async function writeTransaction(hdb_operation, lmdb_response){
    let txn_env_base_path = path.join(getTransactionStorePath(), hdb_operation.schema.toString());
    let txn_env = await environment_util.openEnvironment(txn_env_base_path, hdb_operation.table, true);

    let txn_object = createTransactionObject(hdb_operation, lmdb_response);

    if(txn_object === undefined || txn_object.hash_values.length === 0){
        return;
    }

    if(txn_env !== undefined){
        environment_util.initializeDBIs(txn_env, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, lmdb_terms.TRANSACTIONS_DBIS);
        let txn = undefined;
        try {
            txn = txn_env.beginTxn();

            let txn_timestamp = txn_object.timestamp;
            let txn_timestamp_key_value = lmdb_utils.convertKeyValueToWrite(txn_timestamp, lmdb_terms.DBI_KEY_TYPES.NUMBER);
            txn.putString(txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP], txn_timestamp_key_value, JSON.stringify(txn_object), {noOverwrite: true});
            if (!hdb_util.isEmpty(txn_object.user_name)) {
                txn.putString(txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME], txn_object.user_name.toString(), txn_timestamp.toString());
            }
            for (let x = 0; x < txn_object.hash_values.length; x++) {
                txn.putString(txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE], txn_object.hash_values[x].toString(), txn_timestamp.toString());
            }

            txn.commit();
        }catch(e){
            if(txn !== undefined){
                txn.abort();
            }
            throw e;
        }
    }
}

/**
 *
 * @param {InsertObject | UpdateObject | DeleteObject} hdb_operation
 * @param {InsertRecordsResponseObject | UpdateRecordsResponseObject | DeleteRecordsResponseObject} lmdb_response
 * @returns {LMDBInsertTransactionObject|LMDBUpdateTransactionObject|LMDBDeleteTransactionObject}
 */
function createTransactionObject(hdb_operation, lmdb_response){
    let username = !hdb_util.isEmpty(hdb_operation.hdb_user) ? hdb_operation.hdb_user.username : undefined;
    if(hdb_operation.operation === OPERATIONS_ENUM.INSERT) {
        return new LMDBInsertTransactionObject(hdb_operation.records, username, lmdb_response.txn_time, lmdb_response.written_hashes);
    }

    if(hdb_operation.operation === OPERATIONS_ENUM.UPDATE) {
        return new LMDBUpdateTransactionObject(hdb_operation.records, lmdb_response.original_records, username, lmdb_response.txn_time, lmdb_response.written_hashes);
    }

    if(hdb_operation.operation === OPERATIONS_ENUM.DELETE) {
        return new LMDBDeleteTransactionObject(lmdb_response.deleted, lmdb_response.original_records, username, lmdb_response.txn_time);
    }
}