'use strict';

/**
 * Response object from lmdb update function
 * @param {Array.<string|number>} written_hashes
 * @param {Array.<string|number>} skipped_hashes
 * @param {number} txnTime
 * @param {Array.<Object>} originalRecords
 */
class UpdateRecordsResponseObject {
	/**
	 * @param {Array.<string|number>} written_hashes
	 * @param {Array.<string|number>} skipped_hashes
	 * @param {number} txnTime
	 * @param {Array.<Object>} originalRecords
	 */
	constructor(written_hashes = [], skipped_hashes = [], txnTime = undefined, originalRecords = []) {
		this.written_hashes = written_hashes;
		this.skipped_hashes = skipped_hashes;
		this.txn_time = txnTime;
		this.original_records = originalRecords;
	}
}

module.exports = UpdateRecordsResponseObject;
