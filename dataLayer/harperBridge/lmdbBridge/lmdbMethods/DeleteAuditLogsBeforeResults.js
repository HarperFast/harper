'use strict';

/**
 * represents the response object from Delete audit logs Before
 */
class DeleteAuditLogsBeforeResults {
	/**
	 * @param {number} startTimestamp
	 * @param {number} endTimestamp
	 * @param {number} transactionsDeleted
	 */
	constructor(startTimestamp = undefined, endTimestamp = undefined, transactionsDeleted = 0) {
		this.start_timestamp = startTimestamp;
		this.end_timestamp = endTimestamp;
		this.transactions_deleted = transactionsDeleted;
	}
}

module.exports = DeleteAuditLogsBeforeResults;
