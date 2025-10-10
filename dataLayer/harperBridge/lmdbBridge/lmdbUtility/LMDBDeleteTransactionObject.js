'use strict';
const LMDBTransactionObject = require('./LMDBTransactionObject.js');
const OPERATIONS_ENUM = require('../../../../utility/hdbTerms.ts').OPERATIONS_ENUM;

/**
 * class to define a delete transaction
 */
class LMDBDeleteTransactionObject extends LMDBTransactionObject {
	/**
	 * @param {Array.<string|number>} hash_values - hash values of deleted records
	 * @param {Array.<Object>} originalRecords - original records prior to delete
	 * @param {string} userName - username that executed transaction
	 * @param {number} timestamp - timestamp of transaction
	 * @param {any} origin
	 */
	constructor(hash_values, originalRecords, userName, timestamp, origin = undefined) {
		super(OPERATIONS_ENUM.DELETE, userName, timestamp, hash_values, origin);
		this.original_records = originalRecords;
		//this.hash_values = hash_values;
	}
}

module.exports = LMDBDeleteTransactionObject;
