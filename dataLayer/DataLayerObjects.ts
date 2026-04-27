'use strict';

export class InsertObject {
	operation: string;
	schema: string;
	table: string;
	hash_attribute: string;
	records: any[];
	constructor(operationString: string, schemaString: string, tableString: string, hashAttributeString: string, recordsArray: any[]) {
		this.operation = operationString;
		this.schema = schemaString;
		this.table = tableString;
		this.hash_attribute = hashAttributeString;
		this.records = recordsArray;
	}
}

export class NoSQLSeachObject {
	schema: string;
	table: string;
	attribute: string;
	hash_attribute: string;
	get_attributes: string[];
	value: string;
	constructor(
		schemaString: string,
		tableString: string,
		searchAttributeString: string,
		hashAttributeString: string,
		getAttributesStringArray: string[],
		searchValueString: string
	) {
		this.schema = schemaString;
		this.table = tableString;
		this.attribute = searchAttributeString;
		this.hash_attribute = hashAttributeString;
		this.get_attributes = getAttributesStringArray;
		this.value = searchValueString;
	}
}

export class DeleteResponseObject {
	message: string | undefined;
	deleted_hashes: any[];
	skipped_hashes: any[];
	constructor() {
		this.message = undefined;
		this.deleted_hashes = [];
		this.skipped_hashes = [];
	}
}
