'use strict';

/**
 * represents the response object from Delete Transactions Before
 */
class DeleteTransactionsBeforeResults {
	/**
	 * @param {number} start_timestamp
	 * @param {number} end_timestamp
	 * @param {number} transactions_deleted
	 */
	constructor(start_timestamp = undefined, end_timestamp = undefined, transactions_deleted = 0) {
		this.start_timestamp = start_timestamp;
		this.end_timestamp = end_timestamp;
		this.transactions_deleted = transactions_deleted;
	}
}

module.exports = DeleteTransactionsBeforeResults;
