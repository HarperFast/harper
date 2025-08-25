'use strict';

class InsertObject {
	constructor(operationString, schemaString, tableString, hashAttributeString, recordsArray) {
		this.operation = operationString;
		this.schema = schemaString;
		this.table = tableString;
		this.hash_attribute = hashAttributeString;
		this.records = recordsArray;
	}
}

class NoSQLSeachObject {
	constructor(
		schemaString,
		tableString,
		searchAttributeString,
		hashAttributeString,
		getAttributesStringArray,
		searchValueString
	) {
		this.schema = schemaString;
		this.table = tableString;
		this.search_attribute = searchAttributeString;
		this.hash_attribute = hashAttributeString;
		this.get_attributes = getAttributesStringArray;
		this.search_value = searchValueString;
	}
}

class DeleteResponseObject {
	constructor() {
		this.message = undefined;
		this.deleted_hashes = [];
		this.skipped_hashes = [];
	}
}

module.exports = {
	InsertObject,
	NoSQLSeachObject,
	DeleteResponseObject,
};
