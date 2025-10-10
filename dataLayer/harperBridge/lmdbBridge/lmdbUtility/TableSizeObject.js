'use strict';

/**
 * represents the table size entry for a table
 */
class TableSizeObject {
	/**
	 * @param {String} schema
	 * @param {String} table
	 * @param {Number} tableSize - data size of the table in bytes
	 * @param {Number} recordCount - number of entries in the table
	 * @param {Number} transactionLogSize - number of entries in the transaction log
	 * @param {Number} transactionLogRecordCount - data size of the transaction log in bytes
	 */
	constructor(
		schema,
		table,
		tableSize = 0,
		recordCount = 0,
		transactionLogSize = 0,
		transactionLogRecordCount = 0
	) {
		this.schema = schema;
		this.table = table;
		this.table_size = tableSize;
		this.record_count = recordCount;
		this.transaction_log_size = transactionLogSize;
		this.transaction_log_record_count = transactionLogRecordCount;
	}
}

module.exports = TableSizeObject;
