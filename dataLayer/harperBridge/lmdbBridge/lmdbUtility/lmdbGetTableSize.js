'use strict';

const TableSizeObject = require('./TableSizeObject.js');
const lmdbTerms = require('../../../../utility/lmdb/terms.js');
const lmdbEnvironmentUtility = require('../../../../utility/lmdb/environmentUtility.js');
const log = require('../../../../utility/logging/harper_logger.js');
const { getSchemaPath, getTransactionAuditStorePath } = require('./initializePaths.js');
const { getDatabases } = require('../../../../resources/databases.ts');

module.exports = lmdbGetTableSize;

/**
 * calculates the number of entries & data size in bytes for a table & its transaction log
 * @param tableObject
 * @returns {Promise<TableSizeObject>}
 */
async function lmdbGetTableSize(tableObject) {
	let tableStats = new TableSizeObject();
	try {
		//get the table record count
		let table = getDatabases()[tableObject.schema]?.[tableObject.name];

		let dbiStat = table.primaryStore.getStats();

		//get the txn log record count
		let txnDbiStat = table.auditStore?.getStats();

		tableStats.schema = tableObject.schema;
		tableStats.table = tableObject.name;
		tableStats.record_count = dbiStat.entryCount;
		tableStats.transaction_log_record_count = txnDbiStat.entryCount;
	} catch (e) {
		log.warn(`unable to stat table dbi due to ${e}`);
	}

	return tableStats;
}
