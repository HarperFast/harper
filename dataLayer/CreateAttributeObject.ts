'use strict';

import { v4 as uuidv4 } from 'uuid';

/**
 * Constructor class for inserting an attirbute in HDB
 */
class CreateAttributeObject {
	[key: string]: any;
	/**
	 *
	 * @param schema
	 * @param {String} table
	 * @param {String} attribute
	 * @param {*} [id]
	 */
	constructor(schema, table, attribute, id) {
		this.schema = schema;
		this.table = table;
		this.attribute = attribute;
		this.id = id ? id : uuidv4();
		this.schema_table = `${this.schema}.${this.table}`;
	}
}

export default CreateAttributeObject;
