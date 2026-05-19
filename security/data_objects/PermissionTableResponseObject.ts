'use strict';

export default class PermissionTableResponseObject {
	schema: string;
	table: string;
	required_table_permissions: any[];
	required_attribute_permissions: any[];
	/**
	 * Organizes permission checks into a cohesive response object that will be returned to
	 * the user in the case of a failed permissions check.
	 * @param schema {String}
	 * @param table  {String}
	 * @param requiredTablePerms {Array}
	 * @param requiredAttrPerms {Array}
	 */
	constructor(schema: string, table: string, requiredTablePerms: any[] = [], requiredAttrPerms: any[] = []) {
		this.schema = schema;
		this.table = table;
		this.required_table_permissions = requiredTablePerms;
		this.required_attribute_permissions = requiredAttrPerms;
	}
}
