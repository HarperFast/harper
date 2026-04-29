/**
 * Represents the table size entry for a RocksDB or LMDB table.
 */
export class TableSizeObject {
	schema: string;
	table: string;
	tableSize: number;
	recordCount: number;
	transactionLogSize: number;
	transactionLogRecordCount?: number;

	/**
	 * @param schema - The schema of the table
	 * @param table - The name of the table
	 * @param tableSize - The data size of the table in bytes
	 * @param recordCount - The number of entries in the table
	 * @param transactionLogSize - The number of entries in the transaction log
	 * @param transactionLogRecordCount - The data size of the transaction log in bytes
	 */
	constructor(
		schema: string,
		table: string,
		tableSize: number = 0,
		recordCount: number = 0,
		transactionLogSize: number = 0,
		transactionLogRecordCount?: number
	) {
		this.schema = schema;
		this.table = table;
		this.tableSize = tableSize;
		this.recordCount = recordCount;
		this.transactionLogSize = transactionLogSize;
		this.transactionLogRecordCount = transactionLogRecordCount;
	}
}
