'use strict';

/**
 * This class represents the data that is passed into NoSQL search by hashes.
 */
export default class SearchByHashObject {
	schema: string;
	table: string;
	hash_values: (string | number)[];
	get_attributes: string[];
	/**
	 * @param {String} schema
	 * @param {String} table
	 * @param {Array.<String|Number>} hash_values
	 * @param {Array.<String>} get_attributes
	 */
	constructor(schema: string, table: string, hash_values: (string | number)[], get_attributes: string[]) {
		this.schema = schema;
		this.table = table;
		this.hash_values = hash_values;
		this.get_attributes = get_attributes;
	}
}
