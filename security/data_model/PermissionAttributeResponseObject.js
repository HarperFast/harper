'use strict';

class PermissionAttributeResponseObject {
    /**
     * Used to track role-based, attribute-level permission issues related to an incoming API request/operation
     * @param attr_name {String} name of the attribute with a permission restriction
     * @param required_perms {Array} array of CRU perms that are required on attr for operation
     */
    constructor(attr_name, required_perms = []) {
        this.attribute_name = attr_name;
        this.required_permissions = required_perms;
    }
}

module.exports = PermissionAttributeResponseObject;
