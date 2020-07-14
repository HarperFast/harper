'use strict';

/**
 * base class for transactions
 */
class LMDBTransactionObject{
    /**
     * @param {string} operation - name of operation
     * @param {string} user_name - username that executed transaction
     * @param {number} timestamp - timestamp of transaction
     * @param {[string|number]} hash_values
     */
    constructor(operation, user_name, timestamp, hash_values) {
        this.operation = operation;
        this.user_name = user_name;
        this.timestamp = timestamp;
        this.hash_values = hash_values;
    }
}

module.exports = LMDBTransactionObject;