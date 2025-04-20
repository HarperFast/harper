'use strict';
const LMDBTransactionObject = require('./LMDBTransactionObject.js');
const OPERATIONS_ENUM = require('../../../../utility/hdbTerms.ts').OPERATIONS_ENUM;

/**
 * class to define an update transaction
 */
class LMDBUpsertTransactionObject extends LMDBTransactionObject {
	/**
	 * @param {Array.<Object>} records - records updated
	 * @param {Array.<Object>} originalRecords - original state of records that were updated
	 * @param {string} userName - username that executed the transaction
	 * @param {number} timestamp - timestamp of transaction
	 * @param {[String|Number]} hash_values
	 * @param {ClusteringOriginObject} origin
	 */
	constructor(records, originalRecords, userName, timestamp, hash_values, origin = undefined) {
		super(OPERATIONS_ENUM.UPSERT, userName, timestamp, hash_values, origin);
		this.records = records;
		this.original_records = originalRecords;
	}
}

module.exports = LMDBUpsertTransactionObject;
