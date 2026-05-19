import { TableSizeObject } from '../../TableSizeObject.ts';
import logger from '../../../../utility/logging/harper_logger.ts';
import type { Table } from '../../../../resources/databases.ts';

/**
 * Calculates the number of entries & data size in bytes for a table & its transaction log
 * @param table
 * @returns {TableSizeObject}
 */
export function lmdbGetTableSize(table: Table) {
	const tableStats = new TableSizeObject(table.databaseName, table.tableName);
	try {
		const dbiStat = table.primaryStore.getStats();

		//get the txn log record count
		const txnDbiStat = table.auditStore?.getStats();

		tableStats.recordCount = dbiStat.entryCount;
		tableStats.transactionLogRecordCount = txnDbiStat.entryCount;
	} catch (e) {
		logger.warn(`unable to stat table dbi due to ${e}`);
	}
	return tableStats;
}
