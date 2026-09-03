'use strict';

/**
 * represents the response object from Delete audit logs Before
 */
class DeleteAuditLogsBeforeResults {
	/**
	 * @param {number} startTimestamp
	 * @param {number} endTimestamp
	 * @param {number} transactionsDeleted
	 * @param {number} logFilesDeleted
	 */
	constructor(startTimestamp = undefined, endTimestamp = undefined, transactionsDeleted = 0, logFilesDeleted = 0) {
		this.start_timestamp = startTimestamp;
		this.end_timestamp = endTimestamp;
		this.transactions_deleted = transactionsDeleted;
		this.log_files_deleted = logFilesDeleted;
		this.deprecated = 'Please use delete_transaction_logs_before instead';
	}
}

module.exports = DeleteAuditLogsBeforeResults;
