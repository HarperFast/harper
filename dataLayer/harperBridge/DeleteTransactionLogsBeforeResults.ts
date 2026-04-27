/**
 * The response object from `delete_transaction_logs_before` operation API.
 */
export class DeleteTransactionLogsBeforeResults {
	start_timestamp?: number;
	end_timestamp?: number;
	log_files_deleted: number;

	/**
	 * @param {number} startTimestamp
	 * @param {number} endTimestamp
	 * @param {number} logFilesDeleted
	 */
	constructor(startTimestamp?: number, endTimestamp?: number, logFilesDeleted = 0) {
		this.start_timestamp = startTimestamp;
		this.end_timestamp = endTimestamp;
		this.log_files_deleted = logFilesDeleted;
	}
}
