'use strict';

/**
 * Object that represents a delete before operation
 * @param {string} schema
 * @param {string} table
 * @param {Date|Number|String} timestamp
 */
export default class DeleteBeforeObject {
	schema: string;
	table: string;
	timestamp: Date | number | string;
	/**
	 * @param {string} schema
	 * @param {string} table
	 * @param {Date|Number|String} timestamp
	 */
	constructor(schema: string, table: string, timestamp: Date | number | string) {
		this.schema = schema;
		this.table = table;
		this.timestamp = timestamp;
	}
}
