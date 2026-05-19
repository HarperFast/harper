'use strict';

class CreateTableObject {
	[key: string]: any;
	constructor(schema, table, primary_key) {
		this.schema = schema;
		this.table = table;
		this.primary_key = primary_key;
	}
}

export default CreateTableObject;
