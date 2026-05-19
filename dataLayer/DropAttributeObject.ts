'use strict';

class DropAttributeObject {
	[key: string]: any;
	constructor(schema, table, attribute) {
		this.schema = schema;
		this.table = table;
		this.attribute = attribute;
	}
}

export default DropAttributeObject;
