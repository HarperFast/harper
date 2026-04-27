'use strict';
import { OPERATIONS_ENUM } from '../utility/hdbTerms.js';

/**
 * opject representing an update operation
 */
export default class UpdateObject {
	operation: string;
	schema: string;
	table: string;
	records: any[];
	__origin: any;
	/**
	 * @param {String} schema
	 * @param {string} table
	 * @param {Array.<Object>} records
	 * @param {any} __origin
	 */
	constructor(schema: string, table: string, records: any[], __origin: any = undefined) {
		this.operation = OPERATIONS_ENUM.UPDATE;
		this.schema = schema;
		this.table = table;
		this.records = records;
		this.__origin = __origin;
	}
}
