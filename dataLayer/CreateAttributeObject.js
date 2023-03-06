'use strict';

const uuid = require('uuid');

/**
 * Constructor class for inserting an attirbute in HDB
 */
class CreateAttributeObject {
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
		this.id = id ? id : uuid.v4();
		this.schema_table = `${this.schema}.${this.table}`;
	}
}

module.exports = CreateAttributeObject;
