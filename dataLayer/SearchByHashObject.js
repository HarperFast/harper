'use strict';

/**
 * This class represents the data that is passed into NoSQL search by hashes.
 */
class SearchByHashObject {
	/**
	 * @param {String} schema
	 * @param {String} table
	 * @param {Array.<String|Number>} hash_values
	 * @param {Array.<String>} get_attributes
	 */
	constructor(schema, table, hash_values, get_attributes) {
		this.schema = schema;
		this.table = table;
		this.hash_values = hash_values;
		this.get_attributes = get_attributes;
	}
}

module.exports = SearchByHashObject;
