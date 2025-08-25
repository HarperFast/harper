'use strict';
const LMDBTransactionObject = require('./LMDBTransactionObject.js');
const OPERATIONS_ENUM = require('../../../../utility/hdbTerms.ts').OPERATIONS_ENUM;

/**
 * class to define an insert transaction
 */
class LMDBInsertTransactionObject extends LMDBTransactionObject {
	/**
	 * @param {Array.<Object>} records - inserted records
	 * @param {string} userName - username that executed trasaction
	 * @param {number} timestamp - timestamp of the transaction
	 * @param {[String|Number]} hash_values
	 * @param {ClusteringOriginObject} origin
	 */
	constructor(records, userName, timestamp, hash_values, origin = undefined) {
		super(OPERATIONS_ENUM.INSERT, userName, timestamp, hash_values, origin);
		this.records = records;
	}
}

module.exports = LMDBInsertTransactionObject;
