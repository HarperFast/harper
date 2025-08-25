'use strict';
const OPERATIONS_ENUM = require('../utility/hdbTerms.ts').OPERATIONS_ENUM;

/**
 * object representing an upsert operation
 */
class UpsertObject {
	/**
	 * @param {String} schema
	 * @param {string} table
	 * @param {Array.<Object>} records
	 * @param {ClusteringOriginObject} __origin
	 */
	constructor(schema, table, records, __origin = undefined) {
		this.operation = OPERATIONS_ENUM.UPSERT;
		this.schema = schema;
		this.table = table;
		this.records = records;
		this.__origin = __origin;
	}
}

module.exports = UpsertObject;
