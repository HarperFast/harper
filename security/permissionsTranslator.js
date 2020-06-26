const _ = require('lodash');
const terms = require('../utility/hdbTerms');

module.exports = {
    getRolePermissions
};

const role_perms_map = Object.create(null);
const role_schema_map = Object.create(null);
const perms_template_obj = (perms_key) => ({key: perms_key, perms: {}});

const schema_perms_template = () => ({
    [terms.PERMS_CRUD_ENUM.READ]: false,
    tables: {}
});

const table_perms_template = () => ({
    [terms.PERMS_CRUD_ENUM.READ]: false,
    [terms.PERMS_CRUD_ENUM.INSERT]: false,
    [terms.PERMS_CRUD_ENUM.UPDATE]: false,
    [terms.PERMS_CRUD_ENUM.DELETE]: false,
    attribute_restrictions: []
});

const attr_perms_template = (attr_name) => ({
    attribute_name: attr_name,
    [terms.PERMS_CRUD_ENUM.READ]: false,
    [terms.PERMS_CRUD_ENUM.INSERT]: false,
    [terms.PERMS_CRUD_ENUM.UPDATE]: false,
    [terms.PERMS_CRUD_ENUM.DELETE]: false,
});

const crud_perm_keys = Object.values(terms.PERMS_CRUD_ENUM);

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
            console.log('CACHED!');
            return role_perms_map[role_name].perms;
        }

        if (!role_perms_map[role_name]) {
            role_perms_map[role_name] = perms_template_obj(perms_key);
        } else {
            role_perms_map[role_name].key = perms_key;
        }

        const new_role_perms = translateRolePermissions(role, non_sys_schema);

        role_perms_map[role_name].perms = new_role_perms;
        console.log('NOT CACHED!');
        return new_role_perms;
    } catch(e) {
        throw e;
    }

}

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
                    crud_perm_keys.forEach(key => {
                        if (!!updated_table_perms[key] && !final_permissions[s][terms.PERMS_CRUD_ENUM.READ]) {
                            final_permissions[s][terms.PERMS_CRUD_ENUM.READ] = true;
                        }
                    });
                    final_permissions[s].tables[t] = updated_table_perms;
                } else {
                    //TODO - Are we going to also add schema permissions as well?  If so, make them all FALSE here.
                    final_permissions[s].tables[t] = table_perms_template();
                }
            });
        } else {
            //add false permissions for all schema tables
            Object.keys(schema[s]).forEach(t => {
                //TODO - Are we going to also add schema permissions as well?  If so, make them all FALSE here.
                final_permissions[s].tables[t] = table_perms_template();
            });
        }
    });

    return final_permissions;
}

function getTableAttrPerms(table_perms, table_schema) {
    const { attribute_restrictions } = table_perms;
    const has_attr_restrictions = attribute_restrictions.length > 0;

    if (has_attr_restrictions) {
        const final_table_perms = Object.assign({}, table_perms);
        final_table_perms.attribute_restrictions = [];
        //TODO - turn into a map?
        const attr_r_map = attribute_restrictions.reduce((acc, item) => {
            const { attribute_name } = item;
            acc[attribute_name] = item;
            return acc;
        }, {});

        table_schema.attributes.forEach(({ attribute }) => {
            if (attr_r_map[attribute]) {
                const attr_perm_obj = attr_r_map[attribute];
                final_table_perms.attribute_restrictions.push(attr_perm_obj);
            } else {
                const attr_perms = attr_perms_template(attribute);
                final_table_perms.attribute_restrictions.push(attr_perms);
            }
        });
        return final_table_perms;
    } else{
        return table_perms;
    }
}

function translateRoleSchema(role, schema) {

}

function getRoleSchema(role, schema) {

}
