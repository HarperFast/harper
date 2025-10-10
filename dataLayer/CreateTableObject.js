'use strict';

class CreateTableObject {
	constructor(schema, table, hash_attribute) {
		this.schema = schema;
		this.table = table;
		this.hash_attribute = hash_attribute;
	}
}

module.exports = CreateTableObject;
