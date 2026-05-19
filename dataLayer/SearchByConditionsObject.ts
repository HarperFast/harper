'use strict';

// eslint-disable-next-line no-unused-vars
import * as lmdbTerms from '../utility/lmdb/terms.ts';

/**
 * This class represents the data that is passed into NoSQL searches.
 */
class SearchByConditionsObject {
	[key: string]: any;
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
	[key: string]: any;
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
	[key: string]: any;
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

export { SearchByConditionsObject, SearchCondition, SortAttribute };
