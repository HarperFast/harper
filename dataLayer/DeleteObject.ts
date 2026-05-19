'use strict';

import { OPERATIONS_ENUM } from '../utility/hdbTerms.ts';

/**
 * This class represents the data that is passed into the delete functions.
 */
class DeleteObject {
	[key: string]: any;
	/**
	 *
	 * @param {string} schema
	 * @param {string} table
	 * @param {[string|number]} hash_values
	 * @param {any} __origin
	 */
	constructor(schema, table, hash_values, __origin = undefined) {
		this.operation = OPERATIONS_ENUM.DELETE;
		this.schema = schema;
		this.table = table;
		this.hash_values = hash_values;
		this.__origin = __origin;
	}
}

export default DeleteObject;
