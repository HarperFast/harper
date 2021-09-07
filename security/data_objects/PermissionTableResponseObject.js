'use strict';

class PermissionTableResponseObject {
	/**
	 * Organizes permission checks into a cohesive response object that will be returned to
	 * the user in the case of a failed permissions check.
	 * @param schema {String}
	 * @param table  {String}
	 * @param required_table_perms {Array}
	 * @param required_attr_perms {Array}
	 */
	constructor(schema, table, required_table_perms = [], required_attr_perms = []) {
		this.schema = schema;
		this.table = table;
		this.required_table_permissions = required_table_perms;
		this.required_attribute_permissions = required_attr_perms;
	}
}

module.exports = PermissionTableResponseObject;
