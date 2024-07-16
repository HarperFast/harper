'use strict';

const TableSizeObject = require('./TableSizeObject');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const lmdb_environment_utility = require('../../../../utility/lmdb/environmentUtility');
const log = require('../../../../utility/logging/harper_logger');
const { getSchemaPath, getTransactionAuditStorePath } = require('./initializePaths');
const { getDatabases } = require('../../../../resources/databases');

module.exports = lmdbGetTableSize;

/**
 * calculates the number of entries & data size in bytes for a table & its transaction log
 * @param table_object
 * @returns {Promise<TableSizeObject>}
 */
async function lmdbGetTableSize(table_object) {
	let table_stats = new TableSizeObject();
	try {
		//get the table record count
		let table = getDatabases()[table_object.schema]?.[table_object.name];

		let dbi_stat = table.primaryStore.getStats();

		//get the txn log record count
		let txn_dbi_stat = table.auditStore?.getStats();

		table_stats.schema = table_object.schema;
		table_stats.table = table_object.name;
		table_stats.record_count = dbi_stat.entryCount;
		table_stats.transaction_log_record_count = txn_dbi_stat.entryCount;
	} catch (e) {
		log.warn(`unable to stat table dbi due to ${e}`);
	}

	return table_stats;
}
