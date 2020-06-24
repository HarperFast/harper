'use strict';
const LMDBTransactionObject = require('./LMDBTransactionObject');
const OPERATIONS_ENUM = require('../../../../utility/hdbTerms').OPERATIONS_ENUM;

/**
 * class to define a delete transaction
 * @param {Array.<string|number>} hash_values - hash values of deleted records
 * @param {Array.<Object>} original_records - original records prior to delete
 * @param {string} user_name - username that executed transaction
 * @param {number} timestamp - timestamp of transaction
 */
class LMDBDeleteTransactionObject extends LMDBTransactionObject{
    /**
     * @param {Array.<string|number>} hash_values - hash values of deleted records
     * @param {Array.<Object>} original_records - original records prior to delete
     * @param {string} user_name - username that executed transaction
     * @param {number} timestamp - timestamp of transaction
     */
    constructor(hash_values, original_records, user_name, timestamp) {
        super(OPERATIONS_ENUM.DELETE, user_name, timestamp);
        this.original_records = original_records;
        this.hash_values = hash_values;
    }
}

module.exports = LMDBDeleteTransactionObject;