'use strict';

/**
 * This class represents the data that is passed into NoSQL searches.
 */
class SearchObject {
	/**
	 *
	 * @param {String} schema
	 * @param {String} table
	 * @param {String} attribute
	 * @param {String|Number} value
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
		attribute,
		value,
		hash_attribute,
		get_attributes,
		endValue,
		reverse = false,
		limit = undefined,
		offset = undefined
	) {
		this.schema = schema;
		this.table = table;
		this.attribute = attribute;
		this.value = value;
		this.hash_attribute = hash_attribute;
		this.get_attributes = get_attributes;
		this.end_value = endValue;
		this.reverse = reverse;
		this.limit = limit;
		this.offset = offset;
	}
}

module.exports = SearchObject;
