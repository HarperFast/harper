'use strict';

const PermissionTableResponseObject = require('./PermissionTableResponseObject');
const PermissionAttributeResponseObject = require('./PermissionAttributeResponseObject');
const { COMMON_ERROR_MSGS } = require('../../utility/errors/commonErrors');

/**
 * This object organizes permission checks into a cohesive response object that will be returned to
 * the user in the case of a failed permissions check.
 */
class PermissionResponseObject {
    constructor() {
        this.error = COMMON_ERROR_MSGS.OP_AUTH_PERMS_ERROR;
        this.unauthorized_access = {};
        this.invalid_schema_items = [];
    }

    addInvalidItem(item, schema, table) {
        if (schema && table) {
            const schema_table = `${schema}_${table}`;
            if (this.unauthorized_access[schema_table]) {
                return;
            }
        }
        this.invalid_schema_items.push(item);
    }

    handleUnauthorizedItem(err_msg) {
        this.unauthorized_access = [err_msg];
        return this;
    }

    handleInvalidItem(err_msg) {
        this.invalid_schema_items = [err_msg];
        this.unauthorized_access = [];
        return this;
    }

    addUnauthorizedTable(schema, table, required_perms) {
        const failed_table = new PermissionTableResponseObject();
        failed_table.schema = schema;
        failed_table.table = table;
        failed_table.required_table_permissions = required_perms;

        const schema_table = `${schema}_${table}`;
        this.unauthorized_access[schema_table] = failed_table;
    }

    addUnauthorizedAttributes(attr_keys, schema, table, restricted_attrs) {
        const unauthorized_table_attributes = [];
        attr_keys.forEach(attr => {
            const attribute_object = new PermissionAttributeResponseObject();
            attribute_object.attribute_name = attr;
            attribute_object.required_permissions =  restricted_attrs[attr];
            unauthorized_table_attributes.push(attribute_object);
        });

        const schema_table = `${schema}_${table}`;

        if (this.unauthorized_access[schema_table]) {
            this.unauthorized_access[schema_table].required_attribute_permissions = unauthorized_table_attributes;
        } else {
            const failed_perm_object = new PermissionTableResponseObject();
            failed_perm_object.table = table;
            failed_perm_object.schema = schema;
            failed_perm_object.required_attribute_permissions = unauthorized_table_attributes;
            this.unauthorized_access[schema_table] = failed_perm_object;
        }
    }

    consolidatePermsRestrictions(unauthorized_attrs, failed_perms_obj) {
        const table_index_map = failed_perms_obj.reduce((acc, perm_obj, i) => {
            acc[`${perm_obj.schema}_${perm_obj.table}`] = i;
            return acc;
        }, {});
        unauthorized_attrs.forEach(failed_perm => {
            const table_key = `${failed_perm.schema}_${failed_perm.table}`;
            if (table_index_map[table_key] >= 0) {
                const perm_idx = table_index_map[table_key];
                const perm_obj = failed_perms_obj[perm_idx];
                perm_obj.required_attribute_permissions = failed_perm.required_attribute_permissions;
                failed_perms_obj.splice(perm_idx, 1, perm_obj);
            } else {
                failed_perms_obj.push(failed_perm);
            }
        });
    }

    getPermsResponse() {
        const unauthorized_access_arr = Object.values(this.unauthorized_access);
        if (unauthorized_access_arr.length > 0 || this.invalid_schema_items.length > 0) {
            this.unauthorized_access = unauthorized_access_arr;
            return this;
        }
        return null;
    }
}

module.exports = PermissionResponseObject;
