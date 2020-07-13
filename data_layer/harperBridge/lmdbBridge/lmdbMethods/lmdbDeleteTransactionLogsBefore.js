'use strict';

const environment_utility =  require('../../../../utility/lmdb/environmentUtility');
const {getTransactionStorePath} = require('../lmdbUtility/initializePaths');
const DeleteBeforeObject = require('../../../DeleteBeforeObject');
const TransactionCursor = environment_utility.TransactionCursor;
const path = require('path');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const hdb_utils = require('../../../../utility/common_utils');
const DeleteTransactionsBeforeResults = require('./DeleteTransactionsBeforeResults');
const promisify = require('util').promisify;
const p_settimeout = promisify(setTimeout);

const BATCH_SIZE = 10000;
const SLEEP_TIME_MS = 100;

module.exports = deleteTransactionLogsBefore;

/**
 *
 * @param {DeleteBeforeObject} delete_txn_logs_obj
 */
async function deleteTransactionLogsBefore(delete_txn_logs_obj){
        let schema_path = path.join(getTransactionStorePath(), delete_txn_logs_obj.schema);
        let env = await environment_utility.openEnvironment(schema_path, delete_txn_logs_obj.table, true);
        let all_dbis = environment_utility.listDBIs(env);
        environment_utility.initializeDBIs(env, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, all_dbis);

        let timestamp = delete_txn_logs_obj.timestamp;
        if(isNaN(timestamp)){
            timestamp = new Date(delete_txn_logs_obj.timestamp).valueOf();
        }

        let chunk_results;
        let total_results = new DeleteTransactionsBeforeResults();

        do {
                chunk_results = deleteTransactions(env, timestamp);
                if(total_results.start_timestamp === undefined){
                        total_results.start_timestamp = chunk_results.start_timestamp;
                }

                if(chunk_results.end_timestamp !== undefined){
                        total_results.end_timestamp = chunk_results.end_timestamp;
                }

                total_results.transactions_deleted += chunk_results.transactions_deleted;

                //we do a pause on delete so it opens access to the txn environment for other processes.
                await p_settimeout(SLEEP_TIME_MS);
        }while(chunk_results.transactions_deleted > 0);

        return total_results;
}

/**
 *
 * @param env
 * @param {number} timestamp
 * @returns {DeleteTransactionsBeforeResults}
 */
function deleteTransactions(env, timestamp){
        let txn = undefined;
        let results = new DeleteTransactionsBeforeResults();
        try {
                txn = new TransactionCursor(env, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, true);

                let found = txn.cursor.goToFirst();
                if(hdb_utils.isEmpty(found) || timestamp < found.readDoubleBE(0)){
                        txn.close();
                        return results;
                }
                results.start_timestamp = found.readDoubleBE(0);
                for (found; found !== null; found = txn.cursor.goToNext()) {
                        let key_value = found.readDoubleBE(0);

                        if(key_value >= timestamp){
                                break;
                        }
                        let txn_record = JSON.parse(txn.cursor.getCurrentString());

                        //delete the transaction record
                        txn.txn.del(env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP], found);

                        //delete user index entry
                        let user_name = txn_record[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME];
                        if(!hdb_utils.isEmpty(user_name)){
                                txn.txn.del(env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME], user_name, key_value.toString());
                        }

                        //delete each hash value entry
                        for(let k = 0; k < txn_record.hash_values.length; k++){
                                txn.txn.del(env.dbis[lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE], txn_record.hash_values[k].toString(), key_value.toString());
                        }

                        results.transactions_deleted++;
                        results.end_timestamp = key_value;
                        if(results.transactions_deleted > BATCH_SIZE){
                                break;
                        }
                }

                txn.commit();
                return results;
        }catch(e) {
                if (txn !== undefined) {
                        txn.close();
                }

                throw e;
        }
}