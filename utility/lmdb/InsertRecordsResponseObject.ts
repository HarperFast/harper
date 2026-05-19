'use strict';

/**
 * Response object from lmdb insert function
 * @param {Array.<string|number>} written_hashes
 * @param {Array.<string|number>} skipped_hashes
 * @param {number} txnTime
 */
class InsertRecordsResponseObject {
	[key: string]: any;
	/**
	 * @param {Array.<string|number>} written_hashes
	 * @param {Array.<string|number>} skipped_hashes
	 * @param {number} txnTime
	 */
	constructor(written_hashes = [], skipped_hashes = [], txnTime = undefined) {
		this.written_hashes = written_hashes;
		this.skipped_hashes = skipped_hashes;
		this.txn_time = txnTime;
	}
}

export default InsertRecordsResponseObject;
