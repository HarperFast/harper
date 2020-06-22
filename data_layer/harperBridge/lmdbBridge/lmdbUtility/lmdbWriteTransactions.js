'use strict';

const path = require('path');
const environment_util = require('../../../../utility/lmdb/environmentUtility');
const LMDBTransactionObject = require('./LMDBTransactionObject');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const {getTransactionStorePath} = require('./initializePaths');

module.exports = writeTransaction;


async function writeTransaction(hdb_operation, lmdb_response){
    let txn_env_base_path = path.join(getTransactionStorePath(), hdb_operation.schema.toString());
    let txn_env = await environment_util.openEnvironment(txn_env_base_path, hdb_operation.table);

    let {txn_object, hashes} = createTransactionObject(hdb_operation, lmdb_response);
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

function createTransactionObject(hdb_operation, lmdb_response){
    let txn_object;
    if(hdb_operation.operation === 'insert') {
        txn_object = new LMDBTransactionObject(hdb_operation.operation, hdb_operation.records, undefined, hdb_operation.hdb_user.username, lmdb_response.txn_time);
        return {txn_object, hashes: lmdb_response.written_hashes};
    }


}