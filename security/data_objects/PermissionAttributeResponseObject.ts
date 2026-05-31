'use strict';

export default class PermissionAttributeResponseObject {
	attribute_name: string;
	required_permissions: any[];
	/**
	 * Used to track role-based, attribute-level permission issues related to an incoming API request/operation
	 * @param attrName {String} name of the attribute with a permission restriction
	 * @param requiredPerms {Array} array of CRU perms that are required on attr for operation
	 */
	constructor(attrName: string, requiredPerms: any[] = []) {
		this.attribute_name = attrName;
		this.required_permissions = requiredPerms;
	}
}
