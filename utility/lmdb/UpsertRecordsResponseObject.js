'use strict';

/**
 * Response object from lmdb upsert function
 * @param {Array.<string|number>} written_hashes
 * @param {number} txn_time
 * @param {Array.<Object>} original_records
 */
class UpsertRecordsResponseObject{
    /**
     * @param {Array.<string|number>} written_hashes
     * @param {number} txn_time
     * @param {Array.<Object>} original_records
     */
    constructor(written_hashes = [], txn_time = undefined, original_records = []) {
        this.written_hashes = written_hashes;
        this.txn_time = txn_time;
        this.original_records = original_records;
    }
}

module.exports = UpsertRecordsResponseObject;
