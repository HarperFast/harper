'use strict';

/**
 * Response object from lmdb insert function
 * @param {Array.<string|number>} written_hashes
 * @param {Array.<string|number>} skipped_hashes
 * @param {number} txn_time
 */
class InsertRecordsResponseObject{
    /**
     * @param {Array.<string|number>} written_hashes
     * @param {Array.<string|number>} skipped_hashes
     * @param {number} txn_time
     */
    constructor(written_hashes = [], skipped_hashes = [], txn_time = undefined) {
        this.written_hashes = written_hashes;
        this.skipped_hashes = skipped_hashes;
        this.txn_time = txn_time;
    }
}

module.exports = InsertRecordsResponseObject;