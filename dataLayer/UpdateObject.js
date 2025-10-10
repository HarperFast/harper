'use strict';
const OPERATIONS_ENUM = require('../utility/hdbTerms.ts').OPERATIONS_ENUM;

/**
 * opject representing an update operation
 */
class UpdateObject {
	/**
	 * @param {String} schema
	 * @param {string} table
	 * @param {Array.<Object>} records
	 * @param {any} __origin
	 */
	constructor(schema, table, records, __origin = undefined) {
		this.operation = OPERATIONS_ENUM.UPDATE;
		this.schema = schema;
		this.table = table;
		this.records = records;
		this.__origin = __origin;
	}
}

module.exports = UpdateObject;
