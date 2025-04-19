'use strict';
const OPERATIONS_ENUM = require('../utility/hdbTerms.ts').OPERATIONS_ENUM;
/**
 * This class represents the data that is passed into the Insert functions.
 */
class InsertObject {
	/**
	 * @param {String} schema
	 * @param {String} table
	 * @param {String} hash_attribute
	 * @param {Array.<Object>} records
	 * @param {ClusteringOriginObject} __origin
	 */
	constructor(schema, table, hash_attribute, records, __origin = undefined) {
		this.operation = OPERATIONS_ENUM.INSERT;
		this.schema = schema;
		this.table = table;
		this.hash_attribute = hash_attribute;
		this.records = records;
		this.__origin = __origin;
	}
}

module.exports = InsertObject;
