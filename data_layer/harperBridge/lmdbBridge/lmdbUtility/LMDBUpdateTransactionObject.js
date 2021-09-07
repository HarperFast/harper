'use strict';
const LMDBTransactionObject = require('./LMDBTransactionObject');
const OPERATIONS_ENUM = require('../../../../utility/hdbTerms').OPERATIONS_ENUM;

/**
 * class to define an update transaction
 */
class LMDBUpdateTransactionObject extends LMDBTransactionObject {
	/**
	 * @param {Array.<Object>} records - records updated
	 * @param {Array.<Object>} original_records - original state of records that were updated
	 * @param {string} user_name - username that executed the transaction
	 * @param {number} timestamp - timestamp of transaction
	 * @param {[String|Number]} hash_values
	 * @param {ClusteringOriginObject} origin
	 */
	constructor(records, original_records, user_name, timestamp, hash_values, origin = undefined) {
		super(OPERATIONS_ENUM.UPDATE, user_name, timestamp, hash_values, origin);
		this.records = records;
		this.original_records = original_records;
	}
}

module.exports = LMDBUpdateTransactionObject;
