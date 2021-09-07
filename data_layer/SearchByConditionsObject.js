'use strict';
const lmdb_terms = require('../utility/lmdb/terms');

/**
 * This class represents the data that is passed into NoSQL searches.
 */
class SearchByConditionsObject {
	/**
	 *
	 * @param {String} schema
	 * @param {String} table
	 * @param {[]} get_attributes
	 * @param {[SearchCondition]} conditions
	 * @param {Number} limit
	 * @param {Number} offset
	 * @param {string} operator
	 */
	constructor(schema, table, get_attributes, conditions, limit = undefined, offset = undefined, operator = 'and') {
		this.schema = schema;
		this.table = table;
		this.get_attributes = get_attributes;
		this.limit = limit;
		this.offset = offset;
		this.conditions = conditions;
		this.operator = operator;
	}
}

class SearchCondition {
	/**
	 *
	 * @param {String|Number} search_attribute
	 * @param {lmdb_terms.SEARCH_TYPES} search_type
	 * @param {*} search_value
	 */
	constructor(search_attribute, search_type, search_value) {
		this.search_attribute = search_attribute;
		this.search_type = search_type;
		this.search_value = search_value;
	}
}

class SortAttribute {
	/**
	 *
	 * @param {string|number} attribute
	 * @param {boolean} desc
	 */
	constructor(attribute, desc) {
		this.attribute = attribute;
		this.desc = desc;
	}
}

module.exports = {
	SearchByConditionsObject,
	SearchCondition,
	SortAttribute,
};
