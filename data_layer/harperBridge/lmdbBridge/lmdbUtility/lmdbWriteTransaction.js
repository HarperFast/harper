'use strict';

const path = require('path');
const environment_util = require('../../../../utility/lmdb/environmentUtility');
const LMDBInsertTransactionObject = require('./LMDBInsertTransactionObject');
const LMDBUpdateTransactionObject = require('./LMDBUpdateTransactionObject');
const LMDBDeleteTransactionObject = require('./LMDBDeleteTransactionObject');
const InsertObject = require('../../../InsertObject');
const UpdateObject = require('../../../UpdateObject');
const DeleteObject = require('../../../DeleteObject');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const {getTransactionStorePath} = require('./initializePaths');

module.exports = writeTransaction;

/**
 *
 * @param {InsertObject|UpdateObject|DeleteObject} hdb_operation
 * @param lmdb_response
 * @returns {Promise<void>}
 */
async function writeTransaction(hdb_operation, lmdb_response){
    let txn_env_base_path = path.join(getTransactionStorePath(), hdb_operation.schema.toString());
    let txn_env = await environment_util.openEnvironment(txn_env_base_path, hdb_operation.table);

    let {txn_object, hashes} = createTransactionObject(hdb_operation, lmdb_response);

    if(hashes.length === 0){
        return;
    }

    if(txn_env !== undefined){
        environment_util.initializeDBIs(txn_env, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, lmdb_terms.TRANSACTIONS_DBIS);
        txn_env.beginTxn();

        let txn_timestamp = txn_object.timestamp;
        txn_env.putString(txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP], txn_timestamp, JSON.stringify(txn_object), {noOverwrite: true});
        txn_env.putString(txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME], txn_object.user_name, txn_timestamp);
        for(let x = 0; x < hashes.length; x++){
            txn_env.putString(txn_env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE], hashes[x].toString(), txn_timestamp);
        }

        txn_env.commit();
    }
}

/**
 *
 * @param hdb_operation
 * @param lmdb_response
 * @returns {{hashes: *, txn_object: LMDBInsertTransactionObject}|{hashes: *, txn_object: LMDBUpdateTransactionObject}|{hashes: Array<string|number>, txn_object: LMDBDeleteTransactionObject}|{hashes: [], txn_object: undefined}}
 */
function createTransactionObject(hdb_operation, lmdb_response){
    let txn_object;
    let username = hdb_operation.hdb_user ? hdb_operation.hdb_user.username : undefined;
    if(hdb_operation.operation === 'insert') {
        txn_object = new LMDBInsertTransactionObject(hdb_operation.records, username, lmdb_response.txn_time);
        return {txn_object, hashes: lmdb_response.written_hashes};
    }

    if(hdb_operation.operation === 'update') {
        txn_object = new LMDBUpdateTransactionObject(hdb_operation.records, lmdb_response.original_records, username, lmdb_response.txn_time);
        return {txn_object, hashes: lmdb_response.written_hashes};
    }

    if(hdb_operation.operation === 'delete') {
        txn_object = new LMDBDeleteTransactionObject(lmdb_response.deleted, lmdb_response.original_records, username, lmdb_response.txn_time);
        return {txn_object, hashes: lmdb_response.deleted};
    }

    return {txn_object: undefined, hashes: []};
}