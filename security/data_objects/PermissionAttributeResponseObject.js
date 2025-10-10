'use strict';

class PermissionAttributeResponseObject {
	/**
	 * Used to track role-based, attribute-level permission issues related to an incoming API request/operation
	 * @param attrName {String} name of the attribute with a permission restriction
	 * @param requiredPerms {Array} array of CRU perms that are required on attr for operation
	 */
	constructor(attrName, requiredPerms = []) {
		this.attribute_name = attrName;
		this.required_permissions = requiredPerms;
	}
}

module.exports = PermissionAttributeResponseObject;
