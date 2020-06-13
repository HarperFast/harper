'use strict';

const path = require('path');
const fs = require('fs-extra');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const {getTransactionStorePath} = require('../lmdbUtility/initializePaths');
const hdb_terms = require('../../../../utility/hdbTerms');
const lmdb_terms = require('../../../../utility/lmdb/terms');
// eslint-disable-next-line no-unused-vars
const CreateTableObject = require('../../../CreateTableObject');

module.exports = createTransactionsEnvironment;

/**
 * Creates the environment to hold transactions
 * @param {CreateTableObject} table_create_obj
 * @returns {Promise<void>}
 */
async function createTransactionsEnvironment(table_create_obj){
    let env;
    try {
        //create transactions environment for table
        let transaction_path = path.join(getTransactionStorePath(), table_create_obj.schema.toString());
        await fs.mkdirp(transaction_path);
        env = await environment_utility.createEnvironment(transaction_path, table_create_obj.table, true);
    }catch(e){
        e.message = `unable to create transactions environment for ${table_create_obj.schema}.${table_create_obj.table} due to: ${e.message}`;
        throw e;
    }

    try {
        //create dbis for transactions environment
        environment_utility.createDBI(env, hdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP, false, lmdb_terms.DBI_KEY_TYPES.NUMBER, true);
        environment_utility.createDBI(env, hdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.HASH_VALUE, true, lmdb_terms.DBI_KEY_TYPES.STRING, false);
        environment_utility.createDBI(env, hdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.USER_NAME, true, lmdb_terms.DBI_KEY_TYPES.STRING, false);
    }catch(e){
        e.message = `unable to create dbi for ${table_create_obj.schema}.${table_create_obj.table} due to: ${e.message}`;
        throw e;
    }
}