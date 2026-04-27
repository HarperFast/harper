'use strict';

import { v4 as uuid } from 'uuid';

/**
 * Constructor class for inserting an attirbute in HDB
 */
export default class CreateAttributeObject {
	schema: string;
	table: string;
	attribute: string;
	id: string;
	schema_table: string;
	/**
	 *
	 * @param schema
	 * @param {String} table
	 * @param {String} attribute
	 * @param {*} [id]
	 */
	constructor(schema: string, table: string, attribute: string, id?: string) {
		this.schema = schema;
		this.table = table;
		this.attribute = attribute;
		this.id = id ? id : uuid();
		this.schema_table = `${this.schema}.${this.table}`;
	}
}
