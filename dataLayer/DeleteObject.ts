'use strict';

import { OPERATIONS_ENUM } from '../utility/hdbTerms.js';

/**
 * This class represents the data that is passed into the delete functions.
 */
export default class DeleteObject {
	operation: string;
	schema: string;
	table: string;
	hash_values: (string | number)[];
	__origin: any;
	/**
	 *
	 * @param {string} schema
	 * @param {string} table
	 * @param {[string|number]} hash_values
	 * @param {any} __origin
	 */
	constructor(schema: string, table: string, hash_values: (string | number)[], __origin: any = undefined) {
		this.operation = OPERATIONS_ENUM.DELETE;
		this.schema = schema;
		this.table = table;
		this.hash_values = hash_values;
		this.__origin = __origin;
	}
}
