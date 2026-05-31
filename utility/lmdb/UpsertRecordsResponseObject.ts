'use strict';

/**
 * Response object from lmdb upsert function
 * @param {Array.<string|number>} written_hashes
 * @param {number} txnTime
 * @param {Array.<Object>} originalRecords
 */
class UpsertRecordsResponseObject {
	[key: string]: any;
	/**
	 * @param {Array.<string|number>} written_hashes
	 * @param {number} txnTime
	 * @param {Array.<Object>} originalRecords
	 */
	constructor(written_hashes = [], txnTime = undefined, originalRecords = []) {
		this.written_hashes = written_hashes;
		this.txn_time = txnTime;
		this.original_records = originalRecords;
	}
}

export default UpsertRecordsResponseObject;
