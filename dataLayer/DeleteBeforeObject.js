'use strict';

/**
 * Object that represents a delete before operation
 * @param {string} schema
 * @param {string} table
 * @param {Date|Number|String} timestamp
 */
class DeleteBeforeObject {
	/**
	 * @param {string} schema
	 * @param {string} table
	 * @param {Date|Number|String} timestamp
	 */
	constructor(schema, table, timestamp) {
		this.schema = schema;
		this.table = table;
		this.timestamp = timestamp;
	}
}

module.exports = DeleteBeforeObject;
