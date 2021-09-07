'use strict';

/**
 * Response object from lmdb delete function
 * @param {Array.<string|number>} deleted
 * @param {Array.<string|number>} skipped
 * @param {number} txn_time
 * @param {Array.<Object>} original_records
 */
class DeleteRecordsResponseObject {
	/**
	 * @param {Array.<string|number>} deleted
	 * @param {Array.<string|number>} skipped
	 * @param {number} txn_time
	 * @param {Array.<Object>} original_records
	 */
	constructor(deleted = [], skipped = [], txn_time = undefined, original_records = []) {
		this.deleted = deleted;
		this.skipped = skipped;
		this.txn_time = txn_time;
		this.original_records = original_records;
	}
}

module.exports = DeleteRecordsResponseObject;
