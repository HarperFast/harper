'use strict';

/**
 * base class for transactions
 */
class LMDBTransactionObject {
	/**
	 * @param {string} operation - name of operation
	 * @param {string} userName - username that executed transaction
	 * @param {number} timestamp - timestamp of transaction
	 * @param {[string|number]} hash_values
	 * @param {any} origin
	 */
	constructor(operation, userName, timestamp, hash_values, origin = undefined) {
		this.operation = operation;
		this.user_name = userName;
		this.timestamp = timestamp;
		this.hash_values = hash_values;
		this.origin = origin;
	}
}

module.exports = LMDBTransactionObject;
