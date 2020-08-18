'use strict';

/**
 * This object organizes permission checks into a cohesive response object that will be returned to
 * the user in the case of a failed permissions check.
 */
class PermissionTableResponseObject {
    constructor() {
        this.schema = undefined;
        this.table = undefined;
        this.required_table_permissions = [];
        this.required_attribute_permissions = [];
    }
}

module.exports = PermissionTableResponseObject;
