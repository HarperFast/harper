"use strict";

const _ = require('lodash');
const terms = require('../utility/hdbTerms');

module.exports = {
    getRolePermissions
};

const role_perms_map = Object.create(null);
const perms_template_obj = (perms_key) => ({key: perms_key, perms: {}});

const schema_perms_template = () => ({
    [terms.PERMS_CRUD_ENUM.READ]: false,
    tables: {}
});

const permissions_template = (read_perm = false, insert_perm = false,
    update_perm= false, delete_perm= false) => (
        {
            [terms.PERMS_CRUD_ENUM.READ]: read_perm,
            [terms.PERMS_CRUD_ENUM.INSERT]: insert_perm,
            [terms.PERMS_CRUD_ENUM.UPDATE]: update_perm,
            [terms.PERMS_CRUD_ENUM.DELETE]: delete_perm
        }
);

const table_perms_template = () => ({
    ...permissions_template(),
    attribute_restrictions: []
});

const attr_perms_template = (attr_name, perms = permissions_template()) => ({
    attribute_name: attr_name,
    [READ]: perms[READ],
    [INSERT]: perms[INSERT],
    [UPDATE]: perms[UPDATE],
    [DELETE]: perms[DELETE]
});

const crud_perm_keys = Object.values(terms.PERMS_CRUD_ENUM);
const { READ, INSERT, UPDATE, DELETE } = terms.PERMS_CRUD_ENUM;

/**
 * Takes role object and evaluates and updates stored permissions based on the more restrictive logic now in place
 * NOTE: Values are stored in a memoization framework so they can be quickly accessed if the arguments/parameters for the
 * function call have not changed
 *
 * @param role
 * @returns {{updated permissions object value}}
 */
function getRolePermissions(role) {
    try {
        if (role.permission.super_user || role.permission.cluster_user) {
            return role.permission;
        }

        const non_sys_schema = Object.assign({}, global.hdb_schema);
        delete non_sys_schema[terms.SYSTEM_SCHEMA_NAME];
        const role_name = role.role;
        const perms_key = JSON.stringify([role_name, role['__updatedtime__'], non_sys_schema]);

        if (role_perms_map[role_name] && role_perms_map[role_name].key === perms_key) {
            return role_perms_map[role_name].perms;
        }

        if (!role_perms_map[role_name]) {
            role_perms_map[role_name] = perms_template_obj(perms_key);
        } else {
            role_perms_map[role_name].key = perms_key;
        }

        const new_role_perms = translateRolePermissions(role, non_sys_schema);

        role_perms_map[role_name].perms = new_role_perms;
        return new_role_perms;
    } catch(e) {
        throw e;
    }
}

/**
 * If a perms value is not memoized, this method takes the role and schema and translates final permissions to set for the role
 * and memoize
 *
 * @param role
 * @param schema
 * @returns {{translated_role_perms_obj}}
 */
function translateRolePermissions(role, schema) {
    const final_permissions = Object.create(null);
    final_permissions.super_user = false;
    const perms = role.permission;
    final_permissions[terms.SYSTEM_SCHEMA_NAME] = perms[terms.SYSTEM_SCHEMA_NAME];

    Object.keys(schema).forEach(s => {
        final_permissions[s] = schema_perms_template();
        if (perms[s]) {
            //translate schema.tables to permissions
            Object.keys(schema[s]).forEach(t => {
                if (perms[s].tables[t]) {
                    //need to evaluate individual table perms AND attr perms
                    const table_perms = perms[s].tables[t];
                    const table_schema = schema[s][t];
                    const updated_table_perms = getTableAttrPerms(table_perms, table_schema);
                    //we need to set a read value on each schema for easy evaluation during describe ops - if any
                    // CRUD op is set to true for a table in a schema, we set the schema READ perm to true
                    if (!final_permissions[s][terms.PERMS_CRUD_ENUM.READ]) {
                        crud_perm_keys.forEach(key => {
                            if (updated_table_perms[key]) {
                                final_permissions[s][terms.PERMS_CRUD_ENUM.READ] = true;
                            }
                        });
                    }
                    final_permissions[s].tables[t] = updated_table_perms;
                } else {
                    final_permissions[s].tables[t] = table_perms_template();
                }
            });
        } else {
            //add false permissions for all schema tables
            Object.keys(schema[s]).forEach(t => {
                final_permissions[s].tables[t] = table_perms_template();
            });
        }
    });

    return final_permissions;
}

/**
 * Returns table-specific perms based on the existing permissions and schema for that table
 *
 * @param table_perms
 * @param table_schema
 * @returns {{table_specific_perms}}
 */
function getTableAttrPerms(table_perms, table_schema) {
    const { attribute_restrictions } = table_perms;
    const has_attr_restrictions = attribute_restrictions.length > 0;

    if (has_attr_restrictions) {
        const final_table_perms = Object.assign({}, table_perms);
        final_table_perms.attribute_restrictions = [];
        const attr_r_map = attribute_restrictions.reduce((acc, item) => {
            const { attribute_name } = item;
            acc[attribute_name] = item;
            return acc;
        }, {});

        const table_hash = table_schema[terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_HASH_ATTRIBUTE_KEY];
        const hash_attr_perm = !!attr_r_map[table_hash];
        let attr_perms_all_false = true;

        table_schema.attributes.forEach(({ attribute }) => {
            if (attr_r_map[attribute]) {
                const attr_perm_obj = attr_r_map[attribute];
                final_table_perms.attribute_restrictions.push(attr_perm_obj);
                if (!hash_attr_perm && attr_perms_all_false) {
                    attr_perms_all_false = checkAllAttrPermsFalse(attr_perm_obj);
                }
            } else if (attribute !== table_hash) {
                const attr_perms = attr_perms_template(attribute);
                final_table_perms.attribute_restrictions.push(attr_perms);
            }
        });

        if (!hash_attr_perm) {
            if (attr_perms_all_false) {
                const hash_perms = attr_perms_template(table_hash);
                final_table_perms.attribute_restrictions.push(hash_perms);
            } else {
                const table_perms = permissions_template(
                    final_table_perms[READ],
                    final_table_perms[INSERT],
                    final_table_perms[UPDATE],
                    final_table_perms[DELETE]
                );
                const hash_perms = attr_perms_template(table_hash, table_perms);
                final_table_perms.attribute_restrictions.push(hash_perms);
            }
        }

        return final_table_perms;
    } else{
        return table_perms;
    }
}

function checkAllAttrPermsFalse(attr_perm_obj) {
    return !attr_perm_obj[READ] && !attr_perm_obj[INSERT] && !attr_perm_obj[UPDATE] && !attr_perm_obj[DELETE];
}
