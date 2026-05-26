'use strict';
import { OPERATIONS_ENUM } from '../utility/hdbTerms.ts';
/**
 * This class represents the data that is passed into the Insert functions.
 */
class InsertObject {
	[key: string]: any;
	/**
	 * @param {String} schema
	 * @param {String} table
	 * @param {String} hash_attribute
	 * @param {Array.<Object>} records
	 * @param {any} __origin
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

export default InsertObject;
