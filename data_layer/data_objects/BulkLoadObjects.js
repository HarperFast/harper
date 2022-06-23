'use strict';

class BulkLoadFileObject {
	constructor(operation_func, action, schema, table, file_path, file_type, role_perms = null) {
		this.op = operation_func;
		this.action = action;
		this.schema = schema;
		this.table = table;
		this.file_path = file_path;
		this.file_type = file_type;
		this.role_perms = role_perms;
	}
}

class BulkLoadDataObject {
	constructor(action, schema, table, json_data) {
		this.action = action;
		this.schema = schema;
		this.table = table;
		this.data = json_data;
	}
}

module.exports = {
	BulkLoadFileObject,
	BulkLoadDataObject,
};
