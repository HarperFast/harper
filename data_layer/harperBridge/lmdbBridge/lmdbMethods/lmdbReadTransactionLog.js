'use strict';

const ReadTransactionLogObject = require('../../../ReadTransactionLogObject');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const {getTransactionStorePath} = require('../lmdbUtility/initializePaths');
const path = require('path');
const search_utility = require('../../../../utility/lmdb/searchUtility');

/**
 *
 * @param {ReadTransactionLogObject} read_txn_log_obj
 * @returns {Promise<void>}
 */
async function readTransactionLog(read_txn_log_obj){
    let base_path = path.join(getTransactionStorePath(), read_txn_log_obj.schema);
    let env = await environment_utility.openEnvironment(base_path, read_txn_log_obj.table, true);

    switch(read_txn_log_obj.search_type){
        default:

            break;
    }
}

async function searchAllTransactions(env){
    search_utility.searchAll(env, )
}