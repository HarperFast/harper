'use strict';

/**
 * This class represents the data that is passed into NoSQL searches.
 */
class SearchObject {
	/**
	 *
	 * @param {String} schema
	 * @param {String} table
	 * @param {String} searchAttribute
	 * @param {String|Number} searchValue
	 * @param {String} hash_attribute
	 * @param {[]} get_attributes
	 * @param {String|Number} [endValue] - optional
	 * @param {boolean} reverse
	 * @param {Number} limit
	 * @param {Number} offset
	 */
	constructor(
		schema,
		table,
		searchAttribute,
		searchValue,
		hash_attribute,
		get_attributes,
		endValue,
		reverse = false,
		limit = undefined,
		offset = undefined
	) {
		this.schema = schema;
		this.table = table;
		this.search_attribute = searchAttribute;
		this.search_value = searchValue;
		this.hash_attribute = hash_attribute;
		this.get_attributes = get_attributes;
		this.end_value = endValue;
		this.reverse = reverse;
		this.limit = limit;
		this.offset = offset;
	}
}

module.exports = SearchObject;
