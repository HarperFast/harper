'use strict';;
import * as TableSizeObject from './TableSizeObject.js';
import * as log from '../../../../utility/logging/harper_logger.js';
import { getDatabases } from '../../../../resources/databases.js';
export default lmdbGetTableSize;

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
