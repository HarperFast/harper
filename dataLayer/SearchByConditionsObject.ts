'use strict';

// eslint-disable-next-line no-unused-vars
import * as lmdbTerms from '../utility/lmdb/terms.js';

/**
 * This class represents the data that is passed into NoSQL searches.
 */
export class SearchByConditionsObject {
	schema: string;
	table: string;
	get_attributes: any[];
	conditions: SearchCondition[];
	limit: number | undefined;
	offset: number | undefined;
	operator: string;
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
	constructor(schema: string, table: string, get_attributes: any[], conditions: SearchCondition[], limit: number | undefined = undefined, offset: number | undefined = undefined, operator = 'and') {
		this.schema = schema;
		this.table = table;
		this.get_attributes = get_attributes;
		this.limit = limit;
		this.offset = offset;
		this.conditions = conditions;
		this.operator = operator;
	}
}

export class SearchCondition {
	attribute: string | number;
	comparator: any; //lmdbTerms.SEARCH_TYPES
	value: any;
	/**
	 *
	 * @param {String|Number} attribute
	 * @param {lmdbTerms.SEARCH_TYPES} comparator
	 * @param {*} value
	 */
	constructor(attribute: string | number, comparator: any, value: any) {
		this.attribute = attribute;
		this.comparator = comparator;
		this.value = value;
	}
}

export class SortAttribute {
	attribute: string | number;
	desc: boolean;
	/**
	 *
	 * @param {string|number} attribute
	 * @param {boolean} desc
	 */
	constructor(attribute: string | number, desc: boolean) {
		this.attribute = attribute;
		this.desc = desc;
	}
}
