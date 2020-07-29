'use strict';

const TableSizeObject = require('./TableSizeObject');
const path = require('path');
const lmdb_init_paths = require('./initializePaths');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const lmdb_environment_utility = require('../../../../utility/lmdb/environmentUtility');
const log = require('../../../../utility/logging/harper_logger');

module.exports = lmdbGetTableSize;

/**
 * calculates the number of entries & data size in bytes for a table & its transaction log
 * @param table_object
 * @returns {Promise<TableSizeObject>}
 */
async function lmdbGetTableSize(table_object){
    let table_stats = new TableSizeObject();
    try {
        //get the table record count
        let schema_path = path.join(lmdb_init_paths.getBaseSchemaPath(), table_object.schema);
        let env = await lmdb_environment_utility.openEnvironment(schema_path, table_object.name);
        let dbi_stat = lmdb_environment_utility.statDBI(env, table_object.hash_attribute);

        //get the txn log record count
        let txn_path = path.join(lmdb_init_paths.getTransactionStorePath(), table_object.schema);
        let txn_env = await lmdb_environment_utility.openEnvironment(txn_path, table_object.name, true);
        let txn_dbi_stat = lmdb_environment_utility.statDBI(txn_env, lmdb_terms.TRANSACTIONS_DBI_NAMES_ENUM.TIMESTAMP);

        //get table data size in bytes
        let table_bytes = await lmdb_environment_utility.environmentDataSize(schema_path, table_object.name);
        let txn_bytes = await lmdb_environment_utility.environmentDataSize(txn_path, table_object.name);

        table_stats.schema = table_object.schema;
        table_stats.table = table_object.name;
        table_stats.table_size = table_bytes;
        table_stats.record_count = dbi_stat.entryCount;
        table_stats.transaction_log_size = txn_bytes;
        table_stats.transaction_log_record_count = txn_dbi_stat.entryCount;
    }catch(e){
        log.warn(`unable to stat table dbi due to ${e}`);
    }

    return table_stats;
}