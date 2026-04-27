'use strict';

export default class CreateTableObject {
	schema: string;
	table: string;
	primary_key: string;
	constructor(schema: string, table: string, primary_key: string) {
		this.schema = schema;
		this.table = table;
		this.primary_key = primary_key;
	}
}
