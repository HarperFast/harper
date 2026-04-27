'use strict';
import { OPERATIONS_ENUM } from '../utility/hdbTerms.js';
/**
 * This class represents the data that is passed into the Insert functions.
 */
export default class InsertObject {
	operation: string;
	schema: string;
	table: string;
	hash_attribute: string;
	records: any[];
	__origin: any;
	/**
	 * @param {String} schema
	 * @param {String} table
	 * @param {String} hash_attribute
	 * @param {Array.<Object>} records
	 * @param {any} __origin
	 */
	constructor(schema: string, table: string, hash_attribute: string, records: any[], __origin: any = undefined) {
		this.operation = OPERATIONS_ENUM.INSERT;
		this.schema = schema;
		this.table = table;
		this.hash_attribute = hash_attribute;
		this.records = records;
		this.__origin = __origin;
	}
}
