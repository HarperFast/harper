'use strict';

export default class DropAttributeObject {
	schema: string;
	table: string;
	attribute: string;
	constructor(schema: string, table: string, attribute: string) {
		this.schema = schema;
		this.table = table;
		this.attribute = attribute;
	}
}
