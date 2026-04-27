'use strict';

/**
 * This class represents the data that is passed into NoSQL searches.
 */
export default class SearchObject {
	schema: string;
	table: string;
	attribute: string;
	value: string | number;
	hash_attribute: string;
	get_attributes: any[];
	end_value: string | number | undefined;
	reverse: boolean;
	limit: number | undefined;
	offset: number | undefined;
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
		schema: string,
		table: string,
		attribute: string,
		value: string | number,
		hash_attribute: string,
		get_attributes: any[],
		endValue: string | number | undefined,
		reverse = false,
		limit: number | undefined = undefined,
		offset: number | undefined = undefined
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
