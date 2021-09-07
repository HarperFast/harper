'use strict';

/**
 * This class represents the data that is passed into NoSQL searches.
 */
class SearchObject {
	/**
	 *
	 * @param {String} schema
	 * @param {String} table
	 * @param {String} search_attribute
	 * @param {String|Number} search_value
	 * @param {String} hash_attribute
	 * @param {[]} get_attributes
	 * @param {String|Number} [end_value] - optional
	 * @param {boolean} reverse
	 * @param {Number} limit
	 * @param {Number} offset
	 */
	constructor(
		schema,
		table,
		search_attribute,
		search_value,
		hash_attribute,
		get_attributes,
		end_value,
		reverse = false,
		limit = undefined,
		offset = undefined
	) {
		this.schema = schema;
		this.table = table;
		this.search_attribute = search_attribute;
		this.search_value = search_value;
		this.hash_attribute = hash_attribute;
		this.get_attributes = get_attributes;
		this.end_value = end_value;
		this.reverse = reverse;
		this.limit = limit;
		this.offset = offset;
	}
}

module.exports = SearchObject;
