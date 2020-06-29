'use strict';
const LMDBTransactionObject = require('./LMDBTransactionObject');
const OPERATIONS_ENUM = require('../../../../utility/hdbTerms').OPERATIONS_ENUM;

/**
 * class to define an insert transaction
 * @param {Array.<Object>} records - inserted records
 * @param {string} user_name - username that executed trasaction
 * @param {number} timestamp - timestamp of the transaction
 */
class LMDBInsertTransactionObject extends LMDBTransactionObject{
    /**
     * @param {Array.<Object>} records - inserted records
     * @param {string} user_name - username that executed trasaction
     * @param {number} timestamp - timestamp of the transaction
     */
    constructor(records, user_name, timestamp) {
        super(OPERATIONS_ENUM.INSERT, user_name, timestamp);
        this.records = records;
    }
}

module.exports = LMDBInsertTransactionObject;