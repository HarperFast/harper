'use strict';

class CreateTableObject {
	constructor(schema, table, primary_key) {
		this.schema = schema;
		this.table = table;
		this.primary_key = primary_key;
	}
}

module.exports = CreateTableObject;
