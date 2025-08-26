'use strict';

/**
 * Response object from lmdb delete function
 * @param {Array.<string|number>} deleted
 * @param {Array.<string|number>} skipped
 * @param {number} txnTime
 * @param {Array.<Object>} originalRecords
 */
class DeleteRecordsResponseObject {
	/**
	 * @param {Array.<string|number>} deleted
	 * @param {Array.<string|number>} skipped
	 * @param {number} txnTime
	 * @param {Array.<Object>} originalRecords
	 */
	constructor(deleted = [], skipped = [], txnTime = undefined, originalRecords = []) {
		this.deleted = deleted;
		this.skipped = skipped;
		this.txn_time = txnTime;
		this.original_records = originalRecords;
	}
}

module.exports = DeleteRecordsResponseObject;
