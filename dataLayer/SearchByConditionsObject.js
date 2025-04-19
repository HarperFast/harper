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
	 * @param {String|Number} searchAttribute
	 * @param {lmdbTerms.SEARCH_TYPES} searchType
	 * @param {*} searchValue
	 */
	constructor(searchAttribute, searchType, searchValue) {
		this.search_attribute = searchAttribute;
		this.search_type = searchType;
		this.search_value = searchValue;
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
