'use strict';
import { OPERATIONS_ENUM } from '../utility/hdbTerms.ts';

/**
 * object representing an upsert operation
 */
class UpsertObject {
	[key: string]: any;
	/**
	 * @param {String} schema
	 * @param {string} table
	 * @param {Array.<Object>} records
	 * @param {any} __origin
	 */
	constructor(schema, table, records, __origin = undefined) {
		this.operation = OPERATIONS_ENUM.UPSERT;
		this.schema = schema;
		this.table = table;
		this.records = records;
		this.__origin = __origin;
	}
}

export default UpsertObject;
