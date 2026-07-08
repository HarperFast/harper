/**
 * The response object from `delete_transaction_logs_before` operation API.
 */
export class DeleteTransactionLogsBeforeResults {
	start_timestamp?: number;
	end_timestamp?: number;
	entries_deleted: number;
	log_files_deleted: number;

	/**
	 * @param {number} startTimestamp
	 * @param {number} endTimestamp
	 * @param {number} entriesDeleted
	 * @param {number} logFilesDeleted
	 */
	constructor(startTimestamp?: number, endTimestamp?: number, entriesDeleted = 0, logFilesDeleted = 0) {
		this.start_timestamp = startTimestamp;
		this.end_timestamp = endTimestamp;
		this.entries_deleted = entriesDeleted;
		this.log_files_deleted = logFilesDeleted;
	}
}
