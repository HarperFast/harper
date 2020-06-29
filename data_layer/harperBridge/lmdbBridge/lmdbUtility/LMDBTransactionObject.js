'use strict';

/**
 * base class for transactions
 */
class LMDBTransactionObject{
    /**
     * @param {string} operation - name of operation
     * @param {string} user_name - username that executed transaction
     * @param {number} timestamp - timestamp of transaction
     */
    constructor(operation, user_name, timestamp) {
        this.operation = operation;
        this.user_name = user_name;
        this.timestamp = timestamp;
    }
}

module.exports = LMDBTransactionObject;