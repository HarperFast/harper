'use strict';
const lmdbTerms = require('../utility/lmdb/terms.js');

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
	 * @param {String|Number} attribute
	 * @param {lmdbTerms.SEARCH_TYPES} comparator
	 * @param {*} value
	 */
	constructor(attribute, comparator, value) {
		this.attribute = attribute;
		this.comparator = comparator;
		this.value = value;
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
