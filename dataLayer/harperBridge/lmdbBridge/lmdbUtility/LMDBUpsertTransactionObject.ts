import LMDBTransactionObject from './LMDBTransactionObject.js';
import { OPERATIONS_ENUM } from '../../../../utility/hdbTerms.ts';
/**
 * class to define an update transaction
 */
class LMDBUpsertTransactionObject extends LMDBTransactionObject {
	records: any;
	original_records: any;
	/**
	 * @param {Array.<Object>} records - records updated
	 * @param {Array.<Object>} originalRecords - original state of records that were updated
	 * @param {string} userName - username that executed the transaction
	 * @param {number} timestamp - timestamp of transaction
	 * @param {[String|Number]} hash_values
	 * @param {any} origin
	 */
	constructor(records, originalRecords, userName, timestamp, hash_values, origin = undefined) {
		super(OPERATIONS_ENUM.UPSERT, userName, timestamp, hash_values, origin);
		this.records = records;
		this.original_records = originalRecords;
	}
}

export default LMDBUpsertTransactionObject;
