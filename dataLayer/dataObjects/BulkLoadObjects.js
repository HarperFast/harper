'use strict';

class BulkLoadFileObject {
	constructor(operationFunc, action, schema, table, filePath, fileType, rolePerms = null) {
		this.op = operationFunc;
		this.action = action;
		this.schema = schema;
		this.table = table;
		this.file_path = filePath;
		this.file_type = fileType;
		this.role_perms = rolePerms;
	}
}

class BulkLoadDataObject {
	constructor(action, schema, table, jsonData) {
		this.action = action;
		this.schema = schema;
		this.table = table;
		this.data = jsonData;
	}
}

module.exports = {
	BulkLoadFileObject,
	BulkLoadDataObject,
};
