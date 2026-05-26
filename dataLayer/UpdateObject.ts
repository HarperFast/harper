'use strict';
import { OPERATIONS_ENUM } from '../utility/hdbTerms.ts';

/**
 * opject representing an update operation
 */
class UpdateObject {
	[key: string]: any;
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

export default UpdateObject;
