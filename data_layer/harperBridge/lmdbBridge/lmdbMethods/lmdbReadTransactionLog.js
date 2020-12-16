'use strict';

const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const lmdb_utils = require('../../../../utility/lmdb/commonUtility');
const hdb_terms = require('../../../../utility/hdbTerms');
const hdb_utils = require('../../../../utility/common_utils');
const {getTransactionStorePath} = require('../lmdbUtility/initializePaths');
const path = require('path');
const search_utility = require('../../../../utility/lmdb/searchUtility');
const {TransactionCursor} = require("../../../../utility/lmdb/environmentUtility");
const LMDBTransactionObject = require('../lmdbUtility/LMDBTransactionObject');
const log = require('../../../../utility/logging/harper_logger');

module.exports = readTransactionLog;

/**
 * function execute the read_transaction_log operation
 * @param {ReadTransactionLogObject} read_txn_log_obj
 * @returns {Promise<void>}
 */
async function readTransactionLog(read_txn_log_obj){
    let base_path = path.join(getTransactionStorePath(), read_txn_log_obj.schema);
    let env = await environment_utility.openEnvironment(base_path, read_txn_log_obj.table, true);
    let all_dbis = environment_utility.listDBIs(env);

    environment_utility.initializeDBIs(env, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, all_dbis);

    switch(read_txn_log_obj.search_type){
        case hdb_terms.READ_TRANSACTION_LOG_SEARCH_TYPES_ENUM.TIMESTAMP:
            return searchTransactionsByTimestamp(env, read_txn_log_obj.search_values);
        case hdb_terms.READ_TRANSACTION_LOG_SEARCH_TYPES_ENUM.HASH_VALUE:
            //get the hash attribute
            let hash_attribute = global.hdb_schema[read_txn_log_obj.schema][read_txn_log_obj.table].hash_attribute;
            return searchTransactionsByHashValues(env, read_txn_log_obj.search_values, hash_attribute);
        case hdb_terms.READ_TRANSACTION_LOG_SEARCH_TYPES_ENUM.USERNAME:
            return searchTransactionsByUsername(env, read_txn_log_obj.search_values);
        default:
            return searchTransactionsByTimestamp(env);
    }
}

/**
 *
 * @param {lmdb.Env} env
 * @param {[number]} timestamps
 */
function searchTransactionsByTimestamp(env, timestamps = [0, lmdb_utils.getMicroTime()]){
    if(hdb_utils.isEmpty(timestamps[0])){
        timestamps[0] = 0;
    }

    if(hdb_utils.isEmpty(timestamps[1])){
        timestamps[1] = lmdb_utils.getMicroTime();
    }

    let txn = undefined;
    let results = [];
    try {
        txn = new TransactionCursor(env, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, false);

        let found = txn.cursor.goToFirst();
        if(!hdb_utils.isEmpty(found) && timestamps[0] > found.readDoubleBE(0)){
            let search_value = lmdb_utils.convertKeyValueToWrite(timestamps[0], txn.key_type);
            found = txn.cursor.goToRange(search_value);
        }

        for (found; found !== null && found !== undefined; found = txn.cursor.goToNext()) {
            let key_value = found.readDoubleBE(0);

            if(key_value > timestamps[1]){
                break;
            }
            let txn_record = Object.assign(new LMDBTransactionObject(), JSON.parse(txn.cursor.getCurrentString()));
            results.push(txn_record);
        }

        txn.close();
        return results;
    }catch(e) {
        if (txn !== undefined) {
            txn.close();
        }

        throw e;
    }
}

/**
 *
 * @param {lmdb.Env} env
 * @param {[string]} usernames
 */
function searchTransactionsByUsername(env, usernames = []){

    let results = new Map();
    for(let x = 0; x < usernames.length; x++){
        let username = usernames[x];
        let user_results = search_utility.equals(env, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME, username);
        let ids = [];
        for(let key in user_results){
            ids.push(Number(key));
        }

        results.set(username, batchSearchTransactions(env, ids));
    }

    return Object.fromEntries(results);
}

/**
 *
 * @param {lmdb.Env} env
 * @param {[string]} hash_values
 * @param {string} hash_attribute
 */
function searchTransactionsByHashValues(env, hash_values, hash_attribute){
    let timestamp_hash_map = new Map();
    for(let x = 0; x < hash_values.length; x++){
        let hash_value = hash_values[x];
        let hash_results = search_utility.equals(env, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE, hash_value);

        for(let key in hash_results){
            let number_key = Number(key);
            if(timestamp_hash_map.has(number_key)){
                let entry = timestamp_hash_map.get(number_key);
                entry.push(hash_value.toString());
            } else{
                timestamp_hash_map.set(number_key, [hash_value.toString()]);
            }

        }
    }
    let ids = Array.from(timestamp_hash_map.keys());
    let txns = batchSearchTransactions(env, ids);

    let results_map = new Map();
    //iterate txns & pull out just the records related to the hash
    for(let x = 0; x < txns.length; x++){
        let transaction = txns[x];
        let timestamp = transaction.timestamp;
        let hashes = timestamp_hash_map.get(timestamp);

        loopRecords(transaction, 'records', hash_attribute, hashes, results_map);

        loopRecords(transaction, 'original_records', hash_attribute, hashes, results_map);
    }

    return Object.fromEntries(results_map);
}

/**
 *
 * @param transaction
 * @param records_attribute
 * @param hash_attribute
 * @param hashes
 * @param results_map
 */
function loopRecords(transaction, records_attribute, hash_attribute, hashes, results_map){
    let timestamp = transaction.timestamp;

    if(transaction[records_attribute]){
        for(let y = 0; y < transaction[records_attribute].length; y++){
            let record = transaction[records_attribute][y];
            let hash_value = record[hash_attribute].toString();
            if(hashes.indexOf(hash_value) >= 0){
                if(results_map.has(hash_value)){
                    let txn_objects = results_map.get(hash_value);
                    let txn_object = txn_objects[txn_objects.length - 1];

                    if(txn_object.timestamp === timestamp){
                        txn_object[records_attribute] = [record];
                    } else{
                        let new_txn_object = new LMDBTransactionObject(transaction.operation, transaction.user_name, timestamp, undefined);
                        new_txn_object[records_attribute] = [record];
                        txn_objects.push(new_txn_object);
                    }
                } else {
                    let txn_object = new LMDBTransactionObject(transaction.operation, transaction.user_name, timestamp, undefined);
                    txn_object[records_attribute] = [record];
                    results_map.set(hash_value, [txn_object]);
                }
            }
        }
    }
}

/**
 *
 * @param env
 * @param ids
 * @returns {[LMDBTransactionObject]}
 */
function batchSearchTransactions(env, ids){
    let txn = undefined;
    let results = [];
    try {
        //this sorts the ids numerically asc
        ids.sort((a, b) => a - b);
        txn = new TransactionCursor(env, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, false);

        for(let x = 0; x < ids.length; x++){
            try {
                let number_id = ids[x];
                let binary_id = lmdb_utils.convertKeyValueToWrite(number_id, txn.key_type);

                let binary_key = txn.cursor.goToKey(binary_id);
                if(!hdb_utils.isEmpty(binary_key)){
                    let txn_record = Object.assign(new LMDBTransactionObject(), JSON.parse(txn.cursor.getCurrentString()));
                    results.push(txn_record);
                }
            }catch(e){
                log.warn(e);
            }
        }

        txn.close();
        return results;
    }catch(e) {
        if (txn !== undefined) {
            txn.close();
        }

        throw e;
    }
}