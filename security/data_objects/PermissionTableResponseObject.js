'use strict';

class PermissionTableResponseObject {
	/**
	 * Organizes permission checks into a cohesive response object that will be returned to
	 * the user in the case of a failed permissions check.
	 * @param schema {String}
	 * @param table  {String}
	 * @param requiredTablePerms {Array}
	 * @param requiredAttrPerms {Array}
	 */
	constructor(schema, table, requiredTablePerms = [], requiredAttrPerms = []) {
		this.schema = schema;
		this.table = table;
		this.required_table_permissions = requiredTablePerms;
		this.required_attribute_permissions = requiredAttrPerms;
	}
}

module.exports = PermissionTableResponseObject;
